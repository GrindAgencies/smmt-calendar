// ops-import v1 — bring an Operations person's existing Google Sheet onto their own board.
//
// The new baseshop Operations staff each run their book out of a spreadsheet today.
// Retyping it is how a transition goes wrong, so this reads the sheet directly, shows
// them exactly what it found BEFORE anything is written, and lands it on their own
// private board — not the shared one, and not the live policies ledger.
//
// Why not straight into `policies`: that table drives leaderboards, In Force and
// commission. A spreadsheet of historic business, with names that may not match agent
// codes, would quietly rewrite company numbers. The ticket board is the right landing
// place — it is free-form, it is theirs, and nothing downstream reads it.
//
// Google needs no OAuth for this. A sheet shared as "anyone with the link" exports as
// CSV from a URL built out of its id, which is what a share link already contains. If
// the sheet is private the export returns Google's HTML sign-in page instead of CSV,
// which is detected and reported in plain language rather than importing gibberish.
//
// Actions:
//   preview { url | csv, code }        -> headers, row count, sample, suggested mapping
//   commit  { url | csv, code, mapping, board?, append? }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DBH = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const clean = (s: unknown, n = 300) => (s ?? "").toString().trim().slice(0, n);
const low = (s: unknown) => (s ?? "").toString().trim().toLowerCase();
const uid = () => crypto.randomUUID().slice(0, 8);
const enc = encodeURIComponent;
const MAXROWS = 5000;

async function getJSON(path: string) { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: DBH }); return (await r.json()) || []; }
async function loadKey(k: string) { const rows = await getJSON(`app_settings?key=eq.${enc(k)}&select=value`); return rows[0] ? rows[0].value : null; }
async function saveKey(k: string, v: unknown) {
  await fetch(`${SUPA}/rest/v1/app_settings?on_conflict=key`, { method: "POST",
    headers: { ...DBH, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) });
}

/* ---------- who is asking, and whose board is it ---------- */
async function seatOf(code: string): Promise<{ ok: boolean; seat: string | null; name: string; bases: string[] }> {
  const c = clean(code, 8);
  if (/^\d{4}$/.test(c)) {
    const s = (await getJSON(`ops_accounts?code=eq.${enc(c)}&select=code,label,bases,is_master&limit=1`))[0];
    if (s) return { ok: true, seat: s.is_master ? null : c, name: String(s.label || "Operations"),
                    bases: Array.isArray(s.bases) ? s.bases.map(String) : [] };
  }
  return { ok: false, seat: null, name: "", bases: [] };
}

/* ---------- Google Sheets ---------- */
// A share link carries the id and often the tab (gid); the CSV export is built from both.
function sheetCsvUrl(url: string): string | null {
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url);
  if (!id) return null;
  const gid = /[#&?]gid=([0-9]+)/.exec(url);
  return `https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv` + (gid ? `&gid=${gid[1]}` : "");
}

// RFC4180 enough for real spreadsheets: quoted fields, embedded commas, "" escapes, CRLF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch === "\r") { /* handled by \n */ }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

// A tab-separated paste (straight out of a spreadsheet selection) is far more common
// than someone exporting a CSV by hand, so accept it too.
function parseTable(text: string): string[][] {
  const head = text.split("\n")[0] || "";
  if (head.indexOf("\t") >= 0 && head.split("\t").length > head.split(",").length) {
    return text.split(/\r?\n/).map((l) => l.split("\t")).filter((r) => r.some((c) => c.trim() !== ""));
  }
  return parseCsv(text);
}

async function fetchSheet(url: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const csv = sheetCsvUrl(url);
  if (!csv) return { ok: false, error: "That does not look like a Google Sheets link. Copy the address from the browser bar while the sheet is open." };
  let r: Response;
  try { r = await fetch(csv, { redirect: "follow" }); }
  catch (e) { return { ok: false, error: "Could not reach Google: " + String(e) }; }
  const text = await r.text();
  const ct = low(r.headers.get("content-type") || "");
  if (!r.ok || ct.indexOf("text/html") >= 0 || /^\s*<(!doctype|html)/i.test(text)) {
    return { ok: false, error: "Google would not open that sheet. In the sheet: Share → General access → Anyone with the link → Viewer, then paste the link again." };
  }
  return { ok: true, text };
}

/* ---------- column guessing ---------- */
// Header names people actually use, mapped to the board's columns.
const GUESS: Array<[RegExp, string]> = [
  [/client|insured|customer|name(?!.*agent)/i, "client_name"],
  [/writing.*agent|agent(?!.*split)|producer|writer/i, "writing_agent"],
  [/split.*agent|co.?writer/i, "split_agent"],
  [/split(?!.*agent)|share/i, "split"],
  [/state|province/i, "state"],
  [/carrier|company|provider/i, "company"],
  [/submit|app.*date|date.*app|^date$/i, "date_submitted"],
  [/process|stage|step/i, "process"],
  [/status|disposition/i, "status"],
  [/policy.*(num|#|no)|contract.*num/i, "policy_num"],
  [/target|annual.*prem|ap\b|premium/i, "target_premium"],
  [/product|plan/i, "product"],
  [/face|coverage|death.*benefit|db\b/i, "face_amount"],
];
function guessMapping(headers: string[], cols: any[]): Record<string, string> {
  const valid = new Set(cols.map((c: any) => String(c.key)));
  const out: Record<string, string> = {}; const used = new Set<string>();
  headers.forEach((h, i) => {
    const hv = String(h || "").trim(); if (!hv) return;
    // an exact match on a column label or key wins over any pattern
    const exact = cols.find((c: any) => low(c.label) === low(hv) || low(c.key) === low(hv));
    if (exact && !used.has(exact.key)) { out[String(i)] = exact.key; used.add(exact.key); return; }
    for (const [re, key] of GUESS) {
      if (re.test(hv) && valid.has(key) && !used.has(key)) { out[String(i)] = key; used.add(key); return; }
    }
  });
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = clean(body.action, 20) || "preview";
    const who = await seatOf(String(body.code ?? ""));
    if (!who.ok) return json({ ok: false, error: "Sign in to an Operations seat first." }, 401);

    // read the sheet (link) or the pasted table
    let text = "";
    if (clean(body.url, 500)) {
      const got = await fetchSheet(clean(body.url, 500));
      if (!got.ok) return json({ ok: false, error: got.error });
      text = got.text || "";
    } else if (typeof body.csv === "string" && body.csv.trim()) {
      text = String(body.csv).slice(0, 4_000_000);
    } else {
      return json({ ok: false, error: "Paste a Google Sheets link, or paste the rows themselves." });
    }

    const table = parseTable(text);
    if (table.length < 2) return json({ ok: false, error: "That sheet has a header row but no data under it." });
    const headers = table[0].map((h) => clean(h, 60));
    const rows = table.slice(1, MAXROWS + 1);

    const boardName = clean(body.board, 10) === "gfi" ? "gfi" : "newbiz";
    const KCbase = boardName === "gfi" ? "ops_gfi_columns" : "ops_newbiz_columns";
    const KKbase = boardName === "gfi" ? "ops_gfi_tickets" : "ops_newbiz_tickets";
    const KC = who.seat ? `${KCbase}__${who.seat}` : KCbase;
    const KK = who.seat ? `${KKbase}__${who.seat}` : KKbase;
    let cols = await loadKey(KC); if (!Array.isArray(cols) || !cols.length) cols = await loadKey(KCbase);
    if (!Array.isArray(cols) || !cols.length) cols = [];

    if (action === "preview") {
      return json({ ok: true, headers, row_count: rows.length,
        sample: rows.slice(0, 5).map((r) => headers.map((_h, i) => clean(r[i], 120))),
        columns: cols.map((c: any) => ({ key: c.key, label: c.label })),
        suggested: guessMapping(headers, cols),
        board: boardName, lands_on: who.seat ? `${who.name} (private board)` : "the shared board",
        truncated: rows.length >= MAXROWS });
    }

    if (action !== "commit") return json({ ok: false, error: "unknown action" }, 400);

    const mapping = (body.mapping && typeof body.mapping === "object") ? body.mapping as Record<string, string> : {};
    const pairs = Object.keys(mapping).filter((k) => clean(mapping[k], 40));
    if (!pairs.length) return json({ ok: false, error: "Nothing is mapped yet — tell it which spreadsheet column is which." });

    const made = rows.map((r) => {
      const data: Record<string, string> = {};
      for (const idx of pairs) {
        const key = clean(mapping[idx], 40);
        const v = clean(r[Number(idx)], 300);
        if (key && v) data[key] = v;
      }
      return { id: "nb" + uid(), data, notes: [] as any[], archived: false };
    }).filter((t) => Object.keys(t.data).length);

    if (!made.length) return json({ ok: false, error: "Every row came out empty — check the mapping." });

    const existing = Array.isArray(await loadKey(KK)) ? (await loadKey(KK) as any[]) : [];
    const append = body.append === true;
    const final = append ? existing.concat(made) : made;
    await saveKey(KK, final.slice(0, 8000));

    return json({ ok: true, imported: made.length, replaced: !append,
      total_on_board: Math.min(final.length, 8000), board: boardName,
      lands_on: who.seat ? `${who.name} (private board)` : "the shared board" });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
