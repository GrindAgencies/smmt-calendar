/* road-core.js — THE ONE DEFINITION OF THE ROAD TO EMD (2026-10-26).
   The twenty stages, their stable requirement ids, and the rules for "is this stage done".
   Lifted unchanged out of summit.html so the Profile page's read-only Road summary and the
   ladder itself can never disagree: there is one copy, and both pages load it.

   It reads two globals the host page provides:
     BOARD   the summit-api `board` response (checks, derived, requirements, my_baseshop)
     BYCODE  code -> org node, used only for an agent's baseshop wording ({} is fine)
   Nothing here touches the DOM or the network. */

/* ===== THE ROAD — twenty stages, exactly as Elijah dictated 2026-10-20 ==================
   NAMED `ROAD`, NOT `LADDER`. `LADDER` is already taken: it holds the CODE of the agent whose
   ladder is being viewed (`LADDER=CODE`, `LADDER=this.value` from the agent picker). Declaring
   the spec as `LADDER` parsed fine, passed a node test, and then the first `LADDER=CODE` at
   sign-in replaced the whole array with the string "C1991" — the Road tab rendered nothing but
   "Loading the organization…". Caught on the live site, not by the unit test, because the test
   harness never ran the assignment.
   Replaces the old nineteen-stage ladder and its "Promotion Requirement 1-4" placeholders.

   WHY THIS IS DATA AND NOT AN ARRAY OF NAMES. The old ladder was a list of 19 titles with a
   fixed four placeholder requirements under each, and completion was stored by ARRAY POSITION
   - agent, stage number, [true,false,...]. That is why nothing could survive a reorder: stage 7
   meant "Pass Exam" on Monday and "First Three Clients" on Tuesday, and the stored ticks did not
   know the difference. Every stage, path and requirement below carries a STABLE ID. Display
   order is an attribute, never the identity, and completion is stored against those ids.

   Requirement counts vary on purpose: 3, 5, 4, 6, 10, 3, 3, 3, 2, 5, then the alternatives,
   then 1, 3, 1, alternatives, 4, 4, 3, 4, 4. Nothing here may assume four.

   Stages 11 and 15 are ALTERNATIVES: completing every requirement of EITHER path qualifies.
   A partial mixture across both paths does not. */
var ROAD=[
 {id:'ica', title:'ICA', meaning:"Complete the Independent Contractor's Agreement", reqs:[
   {id:'bg_done', label:'Complete background check.'},
   {id:'bg_paid', label:'Pay for the background check.'},
   {id:'code',    label:'Memorize the code number.'}]},

 {id:'onb1', title:'Onboarding 1', reqs:[
   {id:'orient1', label:'Attend Orientation 1 class.'},
   {id:'mwli',    label:'Complete Money Wealth Life Insurance.'},
   {id:'rdpd',    label:'Complete Rich Dad Poor Dad.'},
   {id:'pfr',     label:'Schedule your PFR.'},
   {id:'exam',    label:'Schedule your exam.'}]},

 {id:'onb2', title:'Onboarding 2', reqs:[
   {id:'comp',      label:'Understand and explain compensation.'},
   {id:'levels',    label:'Memorize promotion levels.'},
   {id:'overrides', label:'Understand overrides.'},
   {id:'list',      label:'Build a list.'}]},

 {id:'list', title:'Building Your List', reqs:[
   {id:'righthand',  label:'Top 25 Right-Hand Men / Women.'},
   {id:'dreamers',   label:'Top 25 Big Dreamers.'},
   {id:'trainers',   label:'Top 25 Trainers and Builders.'},
   {id:'influential',label:'Top 25 Most Influential People.'},
   {id:'networks',   label:'Top 25 People with Large Networks.'},
   {id:'savvy',      label:'Top 25 Financially Savvy People.'}]},

 {id:'appts', title:'Top 10 Appointments', reqs:[
   {id:'a1',label:'Appointment 1.'},{id:'a2',label:'Appointment 2.'},
   {id:'a3',label:'Appointment 3.'},{id:'a4',label:'Appointment 4.'},
   {id:'a5',label:'Appointment 5.'},{id:'a6',label:'Appointment 6.'},
   {id:'a7',label:'Appointment 7.'},{id:'a8',label:'Appointment 8.'},
   {id:'a9',label:'Appointment 9.'},{id:'a10',label:'Appointment 10.'}]},

 {id:'partners3', title:'First Three Business Partners', reqs:[
   {id:'p1',label:'Business partner 1.'},
   {id:'p2',label:'Business partner 2.'},
   {id:'p3',label:'Business partner 3.'}]},

 /* The product types are part of the requirement, not examples. */
 {id:'clients3', title:'First Three Clients', reqs:[
   {id:'c1',label:'Client 1 — Term.'},
   {id:'c2',label:'Client 2 — IUL.'},
   {id:'c3',label:'Client 3 — FIA.'}]},

 /* Aggregates of stages 6 and 7 - NOT three more partners and three more clients. */
 {id:'senior_assoc', title:'Senior Associate Promotion', reqs:[
   {id:'three_partners',label:'Three business partners.'},
   {id:'three_clients', label:'Three clients.'},
   {id:'pass_exam',     label:'Pass your exam.'}]},

 {id:'net_license', title:'Get Your Net License', reqs:[
   {id:'lic_appt',label:'Get fully licensed and appointed.'},
   {id:'first1k', label:'Make $1,000.'}]},

 {id:'producers', title:"The Producer's Club", reqs:[
   {id:'present',  label:'Signed off to present.'},
   {id:'illustrate',label:'Signed off to illustrate.'},
   {id:'apps',     label:'Signed off for applications.'},
   {id:'cft',      label:'Signed off as a Certified Field Trainer (CFT).'},
   {id:'ten_k',    label:'Make $10,000.'}]},

 /* NET licensed in Option 1, LICENSED in Option 2. The distinction is deliberate. */
 {id:'md_promo', title:'Hit Marketing Director Promotion', paths:[
   {id:'opt1', name:'Option 1', reqs:[
     {id:'points45k',label:'45,000 team points.'},
     {id:'net5',     label:'Five net licensed agents.'},
     {id:'cash25k',  label:'$25,000 in cash flow.'}]},
   {id:'opt2', name:'Option 2', reqs:[
     {id:'cash50k',  label:'$50,000 in cash flow.'},
     {id:'lic10',    label:'Ten licensed agents.'}]}]},

 {id:'watch50k', title:'50K Watch Earner', reqs:[
   {id:'cash50k_rolling',label:'Make $50,000 in cash flow over a rolling twelve-month period.'}]},

 {id:'pre_emd', title:'Pre-EMD', reqs:[
   {id:'cash75k_personal',label:'$75,000 in personal cash flow.'},
   {id:'one_md',          label:'One Marketing Director.'},
   {id:'net10',           label:'Ten net licensed agents.'}]},

 {id:'ring100k', title:'100K Ring Earner', reqs:[
   {id:'cash100k_rolling',label:'Make $100,000 in cash flow over a rolling twelve-month period.'}]},

 /* 85% persistency is mandatory on BOTH paths. The 50% personal condition lives inside the
    points requirement, not as a sixth checkbox. */
 {id:'emd', title:'EMD', meaning:'Executive Marketing Director', paths:[
   {id:'path1', name:'Path 1', reqs:[
     {id:'points150k_6mo',label:'150,000 points in six months; 50% must be personal.'},
     {id:'ring100k',      label:'100K Ring Earner.'},
     {id:'watch_md',      label:'One 50K Watch Earner MD.'},
     {id:'second_leg',    label:'Second MD Insurance Leg.'},
     {id:'persist85',     label:'85% persistency.'}]},
   {id:'path2', name:'Path 2', reqs:[
     {id:'points250k_12mo',label:'250,000 points in twelve months; 50% must be personal.'},
     {id:'watch_md',       label:'One 50K Watch Earner MD.'},
     {id:'second_leg',     label:'Second MD Insurance Leg.'},
     {id:'cash150k_personal',label:'$150,000 in personal cash flow.'},
     {id:'persist85',      label:'85% persistency.'}]}]},

 {id:'big_base', title:'The Big Base Shop', reqs:[
   {id:'million_base',label:'One million point base shop.'},
   {id:'lic50',       label:'Fifty licensed agents.'},
   {id:'ring250k',    label:'Personal 250K Ring.'},
   {id:'six_figure',  label:'One six-figure earner.'}]},

 {id:'nvp', title:'National Vice President', reqs:[
   {id:'emd3_direct',label:'Three direct Executive Marketing Directors.'},
   {id:'team2m',     label:'Two million point team.'},
   {id:'lic100',     label:'One hundred licensed agents.'},
   {id:'persist85',  label:'85% persistency.'}]},

 {id:'leaders_council', title:'Leaders Council', reqs:[
   {id:'ring500k',label:'500K Ring.'},
   {id:'team3m',  label:'Three million point team.'},
   {id:'nvp',     label:'NVP (National Vice President).'}]},

 {id:'svp', title:'Senior Vice President', reqs:[
   {id:'emd6_direct',label:'Six direct EMDs (Executive Marketing Directors).'},
   {id:'persist90',  label:'90% persistency.'},
   {id:'team5m',     label:'Five million point team.'},
   {id:'ring1m',     label:'$1 million ring.'}]},

 {id:'senior_partner', title:'Senior Partner', reqs:[
   {id:'team10m',     label:'Ten million point team.'},
   {id:'emd10_direct',label:'Ten direct EMDs (Executive Marketing Directors).'},
   {id:'ring1m',      label:'$1 million ring.'},
   {id:'persist90',   label:'90% persistency.'}]}
];
/* Titles only, for badge alt text and anywhere a flat list is still convenient. */
var STAGES=ROAD.map(function(s){return s.title;});
var STAGE_COUNT=ROAD.length;

/* Every requirement of a stage, flattened, each carrying the path it belongs to. */
function reqsOf(i){
  var s=ROAD[i]; if(!s) return [];
  if(s.paths){
    var out=[];
    s.paths.forEach(function(p){ p.reqs.forEach(function(r){
      out.push({key:s.id+'.'+p.id+'.'+r.id, label:r.label, path:p.id, pathName:p.name});
    });});
    return out;
  }
  return s.reqs.map(function(r){ return {key:s.id+'.'+r.id, label:r.label, path:null}; });
}

/* ===== WHAT COUNTS AS DONE ==============================================================
   Three sources, in order of authority:
     1. RANK the company has actually awarded   - proves the stages up to that promotion
     2. RECORDS the platform already holds      - licensing board, exam
     3. MANUAL ticks against a stable requirement id
   Nothing else. A requirement whose evidence is unknown stays UNRESOLVED; it never defaults
   to complete because the text happens to be on screen. */

/* The rank ceiling, and which requirements the platform's own records already prove.
   BOTH ARE RESOLVED SERVER-SIDE (summit-api board -> BOARD.derived) and simply read here.
   The previous version computed this in the browser from the licensing signals, which only
   ever load for the signed-in user — every teammate would have silently shown as having no
   record evidence at all. The server sees every agent the caller may view, so it answers for
   all of them or for none.

   A rank proves the ladder up to its OWN promotion stage and not one rung further. The old
   rule cleared EVERY stage for an EMD or NVP; under the new ladder that would have quietly
   certified The Big Base Shop, Leaders Council, SVP and Senior Partner for people who have
   never been assessed against them. */
function stageIndexById(id){for(var i=0;i<ROAD.length;i++)if(ROAD[i].id===id)return i;return -1;}
function derivedOf(code){ return ((BOARD.derived||{})[code])||{}; }
function rankClearsTo(code){
  var d=derivedOf(code);
  if(typeof d.upto==='string'&&d.upto) return stageIndexById(d.upto);
  return -1;
}
function derivedReqs(code){ return derivedOf(code).reqs||{}; }
function isDerived(code,i){var c=rankClearsTo(code);return c>=0&&i<=c;}

/* A baseshop may still override the wording for a stage. With no override the canonical
   labels above are used - there are no "Promotion Requirement 1-4" placeholders any more. */
function shopOf(code){var n=BYCODE[code];return ((n&&n.baseshop)||BOARD.my_baseshop||'').toLowerCase();}
function reqLabels(code,i){
  var byShop=(BOARD.requirements||{})[shopOf(code)]||{};
  var l=byShop[String(i)];
  var canon=reqsOf(i);
  if(Array.isArray(l)&&l.length){
    /* An override renames in place; it cannot change how many requirements a stage has,
       because the ids are what completion is stored against. */
    return canon.map(function(r,k){ return {key:r.key, label:(l[k]||r.label), path:r.path, pathName:r.pathName}; });
  }
  return canon;
}
function checkMap(code){ return (BOARD.checks||{})[code]||{}; }

function reqDone(code,i,key){
  if(isDerived(code,i))return true;
  var d=derivedReqs(code); if(d[key])return true;
  return checkMap(code)[key]===true;
}
function checksFor(code,i){
  return reqLabels(code,i).map(function(r){ return reqDone(code,i,r.key); });
}
/* Stages 11 and 15 qualify on EITHER complete path. A partial mixture never qualifies. */
function pathProgress(code,i){
  var s=ROAD[i]; if(!s||!s.paths)return null;
  return s.paths.map(function(p){
    var done=p.reqs.filter(function(r){return reqDone(code,i,s.id+'.'+p.id+'.'+r.id);}).length;
    return {id:p.id, name:p.name, done:done, total:p.reqs.length, complete:done===p.reqs.length};
  });
}
function stageComplete(code,i){
  if(isDerived(code,i))return true;
  var pp=pathProgress(code,i);
  if(pp)return pp.some(function(p){return p.complete;});
  var c=checksFor(code,i);
  return c.length>0&&c.every(Boolean);
}
/* The headline fraction. For an alternatives stage it is the BEST single path, never the sum
   across both - showing 3/5 when one 2-item path is finished would be a lie. */
function stageCount(code,i){
  var pp=pathProgress(code,i);
  if(pp){
    var best=pp[0];
    pp.forEach(function(p){ if(p.complete&&!best.complete) best=p;
      else if(p.complete===best.complete && (p.done/p.total)>(best.done/best.total)) best=p; });
    return {done:best.done,total:best.total};
  }
  var c=checksFor(code,i);
  return {done:c.filter(Boolean).length, total:c.length};
}

/* As a tracker this has to open where you ARE. Starting everyone on stage one every time
   makes a nineteen-stage ladder feel like a brochure instead of a progress board. */
function firstOpenStage(code){
  for(var i=0;i<STAGES.length;i++)if(!stageComplete(code,i))return i;
  return STAGES.length-1;
}
function stagesDone(code){var n=0;for(var i=0;i<STAGES.length;i++)if(stageComplete(code,i))n++;return n;}
