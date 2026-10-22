#!/usr/bin/env python3
"""
Scan every backed-up edge function for the ONE bug class that has produced every
auth hole found on this platform: deciding WHOSE data to serve or write from an
identifier that arrived in the request body.

A GFI agent code and a four-digit Ops seat code are both printed or typed in the
open. Neither is a credential. The only proofs are:
    agent_session_code(p_token)   - a session minted at PIN entry
    ops_authorize(p_token)        - a live Operations session / cron token
    pin_verify / p_pin            - the PIN itself, checked server-side. account-delete and
                                    ops-auth prove identity this way and are correct; without
                                    this third case the scanner cried wolf on both.

Reported per function:
  OPEN     reads a request-supplied identifier, calls NEITHER proof.
  OPS-ONLY calls ops_authorize but never agent_session_code, AND still reads a
           request identifier - the ops-bot shape, where a bare code slipped
           past beside a real token check. Needs a human to read the branch.
  OK       reads an identifier and proves identity.
  n/a      never reads a request-supplied identifier at all.

This is a REVIEW AID, not a verdict: it cannot see which branch guards which
read. Every OPEN / OPS-ONLY row must be read by a person and probed live before
anything is changed.
"""
import os, re, sys, json

ROOT = sys.argv[1] if len(sys.argv) > 1 else "supabase/functions"

# A caller-supplied identifier being read. Covers the spellings actually used in
# this codebase (body.code, p.code, body.by_code, body.agent_code, ...).
IDENT = re.compile(
    r'\b(?:body|p|b|payload|req_body)\s*(?:\.|\[\s*["\'])\s*'
    r'(code|by_code|agent_code|trainer_code|target|who|only)\b'
)
# ...or pulled off the query string.
IDENT_QS = re.compile(r'searchParams\.get\(\s*["\'](code|agent_code|by_code)["\']')

SESSION = re.compile(r'agent_session_code')
PINPROOF = re.compile(r'pin_verify|p_pin\b|account_delete_self|\bpin\b\s*:')
OPSAUTH = re.compile(r'ops_authorize')

def strip_comments(src: str) -> str:
    """Comments on this codebase are long and quote the very patterns we scan for
    (every fix is documented above the code it fixed), so they must go first or
    every fixed function reports as broken."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            q, j = c, i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2; continue
                if src[j] == q: break
                j += 1
            out.append(src[i:j+1]); i = j + 1; continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(c); i += 1
    return "".join(out)

rows = []
for slug in sorted(os.listdir(ROOT)):
    d = os.path.join(ROOT, slug)
    if not os.path.isdir(d): continue
    src = ""
    for dirpath, _, files in os.walk(d):
        for f in files:
            if f.endswith((".ts", ".js")):
                src += open(os.path.join(dirpath, f), encoding="utf-8", errors="replace").read() + "\n"
    if not src.strip(): continue
    code = strip_comments(src)
    reads_ident = bool(IDENT.search(code) or IDENT_QS.search(code))
    has_sess = bool(SESSION.search(code))
    has_ops  = bool(OPSAUTH.search(code))
    has_pin  = bool(PINPROOF.search(code))

    if not reads_ident:
        verdict = "n/a"
    elif has_sess or has_pin:
        verdict = "OK"
    elif has_ops:
        verdict = "OPS-ONLY"
    else:
        verdict = "OPEN"
    rows.append((verdict, slug, reads_ident, has_sess, has_ops, has_pin))

order = {"OPEN": 0, "OPS-ONLY": 1, "OK": 2, "n/a": 3}
rows.sort(key=lambda r: (order[r[0]], r[1]))

counts = {}
for v, *_ in rows: counts[v] = counts.get(v, 0) + 1
print(f"scanned {len(rows)} functions:",
      " ".join(f"{k}={counts.get(k,0)}" for k in ("OPEN","OPS-ONLY","OK","n/a")))
print()
for v, slug, ri, hs, ho, hp in rows:
    if v in ("OPEN", "OPS-ONLY"):
        print(f"  {v:<9} {slug:<22} session={hs} ops_authorize={ho} pin={hp}")
