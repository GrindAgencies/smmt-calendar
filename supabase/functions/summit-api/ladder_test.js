var BOARD={derived:{},checks:{}}, BYCODE={}, CODE='ME';
var LADDER=[
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
var STAGES=LADDER.map(function(s){return s.title;});
var STAGE_COUNT=LADDER.length;

/* Every requirement of a stage, flattened, each carrying the path it belongs to. */
function reqsOf(i){
  var s=LADDER[i]; if(!s) return [];
  if(s.paths){
    var out=[];
    s.paths.forEach(function(p){ p.reqs.forEach(function(r){
      out.push({key:s.id+'.'+p.id+'.'+r.id, label:r.label, path:p.id, pathName:p.name});
    });});
    return out;
  }
  return s.reqs.map(function(r){ return {key:s.id+'.'+r.id, label:r.label, path:null}; });
}

/* What the platform already knows, shown beside the manual checkboxes. No requirement is
   invented here — these are facts the app holds, offered as corroboration. */
function platformSays(i,s){
  s=s||{}; var L=(s.license_status||''), lvl=(s.contract_level||'').toLowerCase();
  var id=(LADDER[i]||{}).id;
  /* Once a count is past its target, saying "14 of 10" reads like a mistake. */
  var tally=function(cur,tgt,noun){
    return cur>=tgt ? (noun+': <b>'+cur+'</b> — target of '+tgt+' met.')
                    : (noun+': <b>'+cur+'</b> of '+tgt+'.');};
  /* Keyed to the STAGE ID, never its position. The previous version tested i===2, i===5,
     i===9 and so on against the old ladder; after the rebuild those positions mean entirely
     different milestones, so it would have told someone on Onboarding 2 that their exam was
     scheduled and shown a field-training tally beside First Three Business Partners.
     Field-training counts are deliberately absent: Top 10 Appointments is NOT the old First
     10 Field Trainings stage, and the brief is explicit that it must not be filled from it. */
  if(id==='ica'&&s.ica)return 'Your record shows an ICA on file.';
  if(id==='onb1'&&L==='Exam Scheduled')return 'Licensing board: <b>Exam Scheduled</b> — scheduling is this stage; passing comes later.';
  if(id==='senior_assoc'){
    if(L==='Passed Exam'||L==='Fully Licensed & Appointed')return 'Licensing board: <b>exam passed</b>.';
    if(lvl.indexOf('senior')>=0)return 'Contract level: <b>Senior Associate</b>.';
  }
  if(id==='net_license'){
    if(L==='Fully Licensed & Appointed')return 'Licensing board: <b>Fully Licensed &amp; Appointed</b>.';
    if(L.indexOf('Applied to the State')>=0)return 'Licensing board: <b>applied to the state</b> — not yet licensed and appointed.';
  }
  if(id==='md_promo'&&(lvl==='md'||lvl.indexOf('marketing director')>=0))return 'Contract level: <b>Marketing Director</b>.';
  if(id==='pre_emd'&&s.team_licensed!=null)return tally(Number(s.team_licensed)||0,10,'Licensed agents on your team');
  if(id==='emd'&&(lvl==='emd'||lvl.indexOf('executive')>=0))return 'Contract level: <b>Executive Marketing Director</b>.';
  if(id==='nvp'&&lvl.indexOf('vice president')>=0)return 'Contract level: <b>National Vice President</b>.';
  return null;
}

/* ===== boot ===================================================================== */
function boot(){
  if(!CODE){location.replace('index.html');return;}
  Promise.all([
    fetch(ORGAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'tree',code:CODE})}).then(function(r){return r.json();}).catch(function(){return null;}),
    fetch(SUMAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'board',code:CODE})}).then(function(r){return r.json();}).catch(function(){return null;})
  ]).then(function(res){
    var t=res[0]||{}, b=res[1]||{};
    /* THE ORG CHART IS THE ONE DELIBERATELY COMPANY-WIDE VIEW. Christopher, asked directly
       (org-api v10): "Names company-wide, details own shop only." org-api already enforces that
       — a `limited` node arrives with its name, level and upline but with email, phone, licence
       status, activity and streak stripped. Filtering those people out here, as this map did
       from 2026-09-28, hid most of the company from most of the company and contradicted the
       rule the Org Chart page itself has always followed.
       Departed people stay as shadow Alumni: on the tree, never counted. */
    NODES=(t.nodes||[]).slice();
    CANEDIT=!!t.can_edit_hierarchy;
    loadCanArchive();
    SCOPE=t.scope||'baseshop';
    BYCODE={};KIDS={};
    NODES.forEach(function(n){n.code=(n.code||'').toUpperCase();BYCODE[n.code]=n;});
    NODES.forEach(function(n){var p=(n.direct_to||'').toUpperCase();if(p&&BYCODE[p])(KIDS[p]=KIDS[p]||[]).push(n);});
    /* Re-root on what this viewer may actually see: for an ELEVATE associate the company root
       is out of scope, so their own EMD becomes the centre of their map. */
    ROOTS=(t.roots||[]).map(function(r){return (typeof r==='string')?r:r.code;})
            .map(function(c){return (c||'').toUpperCase();})
            .filter(function(c){return !!BYCODE[c];});
    if(!ROOTS.length){ROOTS=NODES.filter(function(n){var p=(n.direct_to||'').toUpperCase();return !p||!BYCODE[p];}).map(function(n){return n.code;});}
    if(b&&b.ok)BOARD=b;
    POS=Object.assign({},BOARD.layout||{});
    if(BOARD.zoom)ZOOM=Number(BOARD.zoom)||1;
    /* Past the second generation the map is unreadable at 138 people, so deeper branches
       start folded. Every one of them can be opened individually. */
    /* Opening on 74 bubbles is noise, not insight. The map starts on leadership and their
       direct teams; every branch below opens with one tap on its own + control. */
    /* Opening on depth 1 alone showed 9 bubbles out of 136 people and read as if the rest of the
       company had never been loaded. Two levels shows every leader AND their team leads. */
    NODES.forEach(function(n){if(depthOf(n.code)>=2&&(KIDS[n.code]||[]).length)COLLAPSED[n.code]=true;});
    LADDER=CODE;
    STEP=firstOpenStage(LADDER);
    ['map','perf','road'].forEach(function(k){var b=$('tab_'+k);if(b)b.classList.toggle('on',k===TAB);});
    $('ptitle').textContent=(TAB==='map')?'Org Chart':(TAB==='perf')?'Top Performers':'Road to EMD';
    render();
    setTimeout(function(){var c=$('curtain');if(c)c.classList.add('gone');},900);
  });
}
function depthOf(code,guard){
  var d=0,c=code,g=0;
  while(c&&g++<40){var n=BYCODE[c];if(!n)break;var p=(n.direct_to||'').toUpperCase();if(!p||!BYCODE[p])break;c=p;d++;}
  return d;
}

/* ===== tabs ===================================================================== */
function setTab(t){
  TAB=t;
  ['map','perf','road'].forEach(function(k){var b=$('tab_'+k);if(b)b.classList.toggle('on',k===t);});
  $('ptitle').textContent=(t==='map')?'Org Chart':(t==='perf')?'Top Performers':'Road to EMD';
  render();
}
function render(){
  if(TAB==='map')renderMap();
  else if(TAB==='perf')renderPerf();
  else renderRoad();
}

/* ===== ORGANIZATION MAP ========================================================= */
/* Recursive radial layout. The prototype used three fixed rings for seventeen people;
   this organisation is 138 across six generations, so each subtree is given an angular
   slice proportional to how many visible descendants it has, and the ring radius grows
   with depth. Nobody overlaps and arbitrary depth is supported. */
/* 51 of the 189 people on this chart have left. They belong on a family tree, but drawing all of
   them at once put 139 bubbles on top of each other — the radial layout was sized for the ~138
   working roster. Alumni are therefore folded away by default and brought back with one toggle. */
function alumHidden(n){ return !SHOWALUM && n && n.departed; }
/* An EMD folding someone away on their own chart.
   This is NOT a delete — the org chart is a family tree and nobody is ever removed. It moves
   the person to Alumni: still on the tree, never counted, one toggle from visible again. That
   reversibility is the point. The quit flag has been wrong at least six times on this
   platform, so the action that can be wrong is the action that must be undoable.
   Permission and scope are decided server-side: an EMD reaches their own downline only. */
var ARCHAPI='https://bmfqxtocxkjhsgfnndlo.supabase.co/functions/v1/org-archive';
var CANARCH=false;
function loadCanArchive(){
  return fetch(ARCHAPI,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'can'})})
    .then(function(r){return r.json();})
    .then(function(r){ if(r&&r.ok&&r.allowed){ CANARCH=true; try{paintBubbles();}catch(e){} } })
    .catch(function(){});
}
function toggleDeparted(code,departed){
  var n=BYCODE[code]; if(!n) return;
  var nm=n.name||code;
  var q=departed
    ? 'Move '+nm+' to Alumni?\n\nThey stay on the family tree but stop showing on the chart and '
      +'stop being counted. You can bring them back at any time.'
    : 'Bring '+nm+' back onto the active chart?';
  if(!window.confirm(q)) return;
  fetch(ARCHAPI,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'set',code:code,departed:!!departed})})
   .then(function(r){return r.json();})
   .then(function(r){
     if(!r||!r.ok){ toast((r&&r.error)||'Could not update that person.'); return; }
     n.departed=!!departed;
     paintBubbles(); fitToView();
     var b=document.getElementById('alumBtn');
     if(b)b.textContent=SHOWALUM?('Hide alumni ('+alumCount()+')'):('Show alumni ('+alumCount()+')');
     toast(r.message||'Updated');
   }).catch(function(){ toast('Could not reach the server.'); });
}
function toggleAlumni(){ SHOWALUM=!SHOWALUM; paintBubbles(); fitToView();
  var b=document.getElementById('alumBtn'); if(b)b.textContent=SHOWALUM?('Hide alumni ('+alumCount()+')'):('Show alumni ('+alumCount()+')');
}
function alumCount(){ return NODES.filter(function(n){return n.departed;}).length; }
  function visibleKids(code){
    if(COLLAPSED[code])return [];
    var k=KIDS[code]||[];
    return SHOWALUM ? k : k.filter(function(c){return !c.departed;});
  }
function leafCount(code){
  var k=visibleKids(code);
  if(!k.length)return 1;
  var s=0;for(var i=0;i<k.length;i++)s+=leafCount(k[i].code);
  return s;
}
function layout(){
  /* Two passes, because a ring's size depends on how much of the circle its people actually
     get. A team of 21 does not receive the whole circumference — it receives its parent's
     slice — so pass one measures the tightest slice at each depth and pass two lays the map
     out on rings wide enough for it. Fixed radii were fine for the prototype's seventeen
     people; at 138 they collided into an unreadable knot. */
  var cx=700, cy=520, SQUASH=0.95;
  var minArc=function(d){return d<=2?150:120;};
  var R={0:0}; for(var d=1;d<=12;d++)R[d]=300+(d-1)*185;

  function run(record){
    var laid={};
    function place(code,depth,a0,a1,tier){
      var r=(R[depth]!==undefined?R[depth]:(300+(depth-1)*185))+((tier||0)*170);
      var mid=(a0+a1)/2;
      laid[code]={x:cx+Math.cos(mid)*r, y:cy+Math.sin(mid)*r*SQUASH, depth:depth};
      var k=visibleKids(code); if(!k.length)return;
      var span=Math.max(0.0001,a1-a0), total=0;
      k.forEach(function(c){total+=leafCount(c.code);});
      /* Slices are proportional to team size so a big team gets room, but every child is
         guaranteed a floor — otherwise a one-person branch beside a twenty-one person branch
         gets a sliver and collides with its neighbour while the big team looks fine. */
      var floorW=Math.min(span/k.length, 0.16);
      var extra=Math.max(0, span-floorW*k.length);
      /* A team of thirty-five cannot fit legibly on one ring at any sane radius, so a wide
         team is dealt onto two concentric sub-rings. Neighbours on the same ring end up twice
         as far apart, which is what makes the names readable again. */
      var split=k.length>14, cur=a0;
      k.forEach(function(c,ix){
        var w=floorW+extra*(leafCount(c.code)/total);
        var eff=split?w*2:w;   /* same-ring neighbours are two slices apart */
        if(record)record[depth+1]=Math.max(record[depth+1]||0, minArc(depth+1)/Math.max(eff,0.0001));
        place(c.code,depth+1,cur,cur+w,split?(ix%2):0);
        cur+=w;
      });
    }
    if(ROOTS.length===1){ place(ROOTS[0],0,-Math.PI,Math.PI); }
    else {
      var n=ROOTS.length, step=(Math.PI*2)/n;
      ROOTS.forEach(function(rc,i){ place(rc,0,-Math.PI+i*step,-Math.PI+(i+1)*step); });
      ROOTS.forEach(function(rc,i){ var a=-Math.PI/2+i*step;
        if(laid[rc]){laid[rc].x=cx+Math.cos(a)*175;laid[rc].y=cy+Math.sin(a)*150;} });
    }
    return laid;
  }

  var need={};
  run(need);
  var prev=0;
  for(var d2=1;d2<=12;d2++){
    R[d2]=Math.min(2200, Math.max(prev+185, 300+(d2-1)*185, need[d2]||0));
    prev=R[d2];
  }
  return run(null);
}
function shownTagsOf(code){ return BOARD.agent_tags[code]||[]; }
function passesTags(code){
  if(!ACTIVETAGS.length)return true;
  var t=shownTagsOf(code);
  return ACTIVETAGS.every(function(x){return t.indexOf(x)>=0;});
}
function renderMap(){
  var tagbar=BOARD.tags.length?('<div class="tagbar">'+BOARD.tags.map(function(t){
      return '<button class="tagchip'+(ACTIVETAGS.indexOf(t.id)>=0?' on':'')+'" onclick="toggleTag(\''+esc(t.id)+'\')">'+esc(t.label)+'</button>';
    }).join('')+(ACTIVETAGS.length?'<button class="tagchip" onclick="ACTIVETAGS=[];renderMap()">Clear</button>':'')+'</div>'):'';
  $('view').innerHTML=
    '<div class="maptools">'
    +'<input class="srch" id="q" placeholder="Search a name…" value="'+esc(QUERY)+'" oninput="QUERY=this.value;paintBubbles()">'
    +'<button class="tool" onclick="centreMap()">Center</button>'
    +'<button class="tool" onclick="resetLayout()">Reset layout</button>'
    +'<button class="tool" onclick="expandAll()">Expand all</button>'
    +'<button class="tool" id="alumBtn" onclick="toggleAlumni()" title="People who have left stay on the family tree but are never counted">Show alumni ('+alumCount()+')</button>'
    +(CANEDIT?'<button class="tool" id="mvCancel" onclick="cancelMove()" style="display:none">Cancel move</button>':'')
    +'<button class="tool" onclick="collapseDeep()">Collapse</button>'
    +'<span class="zoomwrap"><button class="iconbtn" onclick="bumpZoom(-0.15)">−</button>'
    +'<span class="zpct" id="zpct">'+Math.round(ZOOM*100)+'%</span>'
    +'<button class="iconbtn" onclick="bumpZoom(0.15)">+</button></span></div>'
    +tagbar
    +'<div id="stage"><div id="plane"><svg id="wires"></svg></div></div>'
    +'<div class="maphint"><span id="shownCount" style="color:var(--gold)"></span>'+(CANEDIT?'<span><b style="color:var(--gold)">\u21c4</b> on a bubble, then tap their new upline</span>':'')
    +'<span>Drag a bubble to move it</span><span>Drag the canvas to pan</span>'
    +'<span>Scroll to zoom</span><span>− / + on a bubble folds that team</span></div>';
  wireStage();
  paintBubbles();
}
function paintBubbles(){
  setTimeout(updateShownCount,0);
  var plane=$('plane'); if(!plane)return;
  var laid=layout();
  var q=QUERY.trim().toLowerCase();
  /* wires first so bubbles sit above them */
  var svg=$('wires'); var lines='';
  Object.keys(laid).forEach(function(code){
    visibleKids(code).forEach(function(c){
      var a=POS[code]||laid[code], b=POS[c.code]||laid[c.code];
      if(!a||!b)return;
      lines+='<line x1="'+a.x.toFixed(1)+'" y1="'+a.y.toFixed(1)+'" x2="'+b.x.toFixed(1)+'" y2="'+b.y.toFixed(1)
        +'" stroke="rgba(242,209,122,.5)" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    });
  });
  svg.setAttribute('width','1400');svg.setAttribute('height','1100');
  svg.innerHTML=lines;
  /* bubbles */
  var html='';
  Object.keys(laid).forEach(function(code){
    var n=BYCODE[code];if(!n)return;
    var p=POS[code]||laid[code];
    var d=laid[code].depth;
    var size=d===0?96:(d===1?76:62);
    var rk=rankOf(n);
    var prod=(BOARD.production[code]||{}).points||0;
    var kids=(KIDS[code]||[]).length;
    var hit=q&&(n.name||'').toLowerCase().indexOf(q)>=0;
    var dim=(q&&!hit)||!passesTags(code);
    var face=n.has_photo
      ? '<img src="'+AVATAR+'?code='+encodeURIComponent(code)+'" alt="" loading="lazy">'
      : esc(initials(n.name));
    var alum=!!n.departed, other=!!n.limited;
      var extra=(alum?' alum':'')+(other?' othershop':'')+((MOVING===code)?' moving':'')
              +((MOVING&&MOVING!==code&&canDropOn(code))?' droptarget':'');
      html+='<div class="bub'+(dim?' dim':'')+(hit?' hit':'')+extra+'" data-code="'+esc(code)+'" '
      +'style="left:'+p.x.toFixed(1)+'px;top:'+p.y.toFixed(1)+'px" onclick="bubbleTap(\''+esc(code)+'\')">'
      +'<div class="disc" style="width:'+size+'px;height:'+size+'px;font-size:'+(size*0.3).toFixed(0)+'px">'+face
      +(prod?'<span class="prod">'+fmtPts(prod)+'</span>':'')
      +(kids?'<button class="tog" onclick="event.stopPropagation();toggleBranch(\''+esc(code)+'\')" title="Fold this team">'+(COLLAPSED[code]?'+':'−')+'</button>':'')
      +((CANEDIT&&!n.departed&&code!==ROOTS[0])?'<button class="mv" onclick="event.stopPropagation();startMove(\''+esc(code)+'\')" title="Move this person under a different upline">\u21c4</button>':'')
      +((CANARCH&&code!==ROOTS[0]&&code!==CODE)?'<button class="arch" onclick="event.stopPropagation();toggleDeparted(\''+esc(code)+'\','+(n.departed?'false':'true')+')" title="'+(n.departed?'Bring back onto the active chart':'Move to Alumni — stays on the family tree, stops being counted')+'">'+(n.departed?'\u21a9':'\u2715')+'</button>':'')
      +'</div>'
      +'<div class="bnm"'+(d>=3?' style="font-size:11px;max-width:104px"':'')+'>'+esc(n.name||code)+'</div>'
      +((d>=3&&!rk)?'':'<div class="brk '+(rk?rk.cls:'rank-pending')+'">'+esc(rk?rk.short:'Rank pending')+'</div>')
      +'</div>';
  });
  /* keep the svg, replace the bubbles */
  Array.prototype.slice.call(plane.querySelectorAll('.bub')).forEach(function(e){e.remove();});
  plane.insertAdjacentHTML('beforeend',html);
  applyTransform();
}
function applyTransform(){
  var p=$('plane');if(!p)return;
  p.style.transform='translate('+PAN.x+'px,'+PAN.y+'px) scale('+ZOOM+')';
  var z=$('zpct');if(z)z.textContent=Math.round(ZOOM*100)+'%';
}
var clampZ=function(v){return Math.max(.35,Math.min(2.2,v));};
function bumpZoom(d){ZOOM=clampZ(ZOOM+d);applyTransform();saveLayout();}
function centreMap(){
  var st=$('stage');if(!st)return;
  var r=st.getBoundingClientRect();
  PAN.x=r.width/2-700*ZOOM; PAN.y=r.height/2-520*ZOOM;
  applyTransform();saveLayout();
}
function resetLayout(){
  POS={};ZOOM=1;PAN={x:0,y:0};
  fetch(SUMAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'layout_reset',code:CODE})}).catch(function(){});
  paintBubbles();centreMap();toast('Layout reset');
}
function fitToView(){
  /* A correctly spaced ring can be very wide, so the camera frames whatever is open rather
     than leaving people to hunt for their team off the edge of the canvas. */
  var st=$('stage');if(!st)return;
  var laid=layout(), xs=[], ys=[];
  Object.keys(laid).forEach(function(c){var p=POS[c]||laid[c];xs.push(p.x);ys.push(p.y);});
  if(!xs.length)return;
  var pad=130;
  var minX=Math.min.apply(null,xs)-pad, maxX=Math.max.apply(null,xs)+pad;
  var minY=Math.min.apply(null,ys)-pad, maxY=Math.max.apply(null,ys)+pad;
  var r=st.getBoundingClientRect();
  var z=clampZ(Math.min(r.width/(maxX-minX), r.height/(maxY-minY)));
  ZOOM=z;
  PAN.x=r.width/2-((minX+maxX)/2)*z;
  PAN.y=r.height/2-((minY+maxY)/2)*z;
  applyTransform();saveLayout();
}
function expandAll(){COLLAPSED={};paintBubbles();fitToView();}
/* "9 of 136" is the difference between a folded chart and a chart that looks broken. */
function updateShownCount(){
  var el=document.getElementById('shownCount'); if(!el)return;
  var shown=document.querySelectorAll('.bub').length;
  var total=NODES.filter(function(n){return !n.departed;}).length;
  el.textContent=shown+' of '+total+' shown'+(shown<total?' \u2014 Expand all for the rest':'');
}

/* ===== Cashflow levels (Eli + Operations only) =====
   Adding a level is deliberately NOT an EMD power: an EMD could otherwise invent a level they
   have just cleared and hand themselves a diamond. summit-api enforces the same rule server-side,
   so this button only hides a control that would be refused anyway. */
function canSetLevels(){ return !!(BOARD && BOARD.can_set_levels); }
function openLevels(){
  if(!canSetLevels()){ toast('Only Elijah Cox and Operations can change the cashflow levels.'); return; }
  var t=cashTiers();
  var rows=t.map(function(x,i){return lvlRow(x.at,x.name,i);}).join('');
  var h='<h3>Cashflow levels past EMD</h3>'
   +'<p style="font-size:12.5px;color:var(--ink3);line-height:1.5;margin:0 0 14px">Every level someone crosses adds a diamond to their emblem. Paid cashflow only \u2014 the same number the Road to EMD already shows.</p>'
   +'<div id="lvlRows">'+rows+'</div>'
   +'<button class="tool" style="margin-top:10px" onclick="addLvlRow()">+ Add a level</button>'
   +'<div id="lvlErr" style="color:#e0533d;font-size:12.5px;margin-top:10px"></div>'
   +'<div class="dact" style="margin-top:16px;display:flex;gap:8px"><button class="go" id="lvlSave" onclick="saveLevels()">Save levels</button>'
   +'<button class="tool" onclick="closeDrawer()">Cancel</button></div>';
  $('drawer').innerHTML=h; $('ov').classList.add('on');
}
function lvlRow(at,name,i){
  return '<div class="lvlrow" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">'
   +'<span style="width:22px;height:22px;flex:0 0 auto;background:linear-gradient(145deg,#eaf6ff,#7fc4ff 40%,#2a7fd4 75%,#0d3f73);transform:rotate(45deg);border-radius:3px"></span>'
   +'<input class="lvlAt" type="number" min="1" step="1000" value="'+(Number(at)||0)+'" placeholder="500000" style="width:130px;border:1.5px solid var(--line2,#2b2410);border-radius:10px;padding:9px 11px;background:var(--panel,#111006);color:var(--ink,#f6f1e0);font-family:inherit;font-size:14px">'
   +'<input class="lvlName" value="'+esc(name||'')+'" placeholder="Name this level" style="flex:1;min-width:0;border:1.5px solid var(--line2,#2b2410);border-radius:10px;padding:9px 11px;background:var(--panel,#111006);color:var(--ink,#f6f1e0);font-family:inherit;font-size:14px">'
   +'<button class="tool" onclick="this.parentNode.remove()" title="Remove this level">\u2715</button></div>';
}
function addLvlRow(){ var h=document.getElementById('lvlRows'); if(h)h.insertAdjacentHTML('beforeend', lvlRow('','',0)); }
function saveLevels(){
  var rows=[].slice.call(document.querySelectorAll('#lvlRows .lvlrow'));
  var tiers=rows.map(function(r){
    return { at: Math.round(Number(r.querySelector('.lvlAt').value)||0),
             name: (r.querySelector('.lvlName').value||'').trim() };
  }).filter(function(t){return t.at>0;});
  var err=document.getElementById('lvlErr');
  if(!tiers.length){ err.textContent='Add at least one level.'; return; }
  var btn=document.getElementById('lvlSave'); btn.disabled=true; btn.textContent='Saving\u2026';
  fetch(SUMAPI,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'tiers_set',code:CODE,tiers:tiers})})
   .then(function(r){return r.json();})
   .then(function(r){
     if(!r||!r.ok){ err.textContent=(r&&r.error)||'Could not save.'; btn.disabled=false; btn.textContent='Save levels'; return; }
     BOARD.tiers=r.tiers; closeDrawer(); toast('Levels saved \u2014 emblems update on the next load');
     if(typeof renderRoad==='function')renderRoad(); else paintBubbles();
   })
   .catch(function(){ err.textContent='Network error.'; btn.disabled=false; btn.textContent='Save levels'; });
}

/* ===== Moving someone on the tree =====
   Reparenting is TWO TAPS, not a drag: dragging a bubble already repositions it, and drag-and-drop
   is miserable on a phone — which is where most of this team works. Tap the person, then tap their
   new upline. org-api is the authority on who may do this (Operations and Eli Cox only, NOT every
   MD/EMD), so the button only appears when the API says can_edit_hierarchy. org.html decided that
   client-side from the viewer's level, which offered the control to MDs whose save was then
   refused with a 403. */
function canDropOn(target){
  if(!MOVING||target===MOVING)return false;
  var n=BYCODE[target]; if(!n||n.departed)return false;          /* never report to an alumnus */
  /* descendantsOf() is the page's own helper and returns an ARRAY OF NODES, not a lookup —
     a second copy of it here silently lost to the original and let someone be moved under
     their own downline, which org-api would then refuse. */
  var below=descendantsOf(MOVING)||[];
  for(var i=0;i<below.length;i++) if(below[i] && below[i].code===target) return false;
  return true;
}
function bubbleTap(code){
  if(!MOVING){ openAgent(code); return; }
  if(code===MOVING){ MOVING=null; paintBubbles(); toast('Move cancelled'); return; }
  if(!canDropOn(code)){
    var n=BYCODE[code];
    toast(n&&n.departed ? 'That person has left — pick someone active.'
                        : 'You can\u2019t move someone under their own downline.');
    return;
  }
  var who=BYCODE[MOVING], up=BYCODE[code];
  if(!confirm('Move '+(who&&who.name||MOVING)+' to report to '+(up&&up.name||code)+'?')) return;
  doMove(MOVING, code);
}
function startMove(code){
  if(!CANEDIT){ toast('The hierarchy is managed by Operations and Eli Cox.'); return; }
  MOVING=code; paintBubbles();
  var n=BYCODE[code];
  toast('Now tap '+((n&&n.name||'this person').split(' ')[0])+'\u2019s new upline \u2014 or tap them again to cancel');
}
function cancelMove(){ MOVING=null; paintBubbles(); }
function doMove(code,upline){
  var prev=MOVING; MOVING=null; paintBubbles();
  fetch(ORGAPI,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'set_upline',code:code,direct_to:upline,by:CODE})})
   .then(function(r){return r.json();})
   .then(function(r){
     if(!r||!r.ok){ toast((r&&r.error)||'Could not move them.'); MOVING=prev; paintBubbles(); return; }
     var n=BYCODE[code]; if(n){ n.direct_to=upline; n.direct_to_name=(BYCODE[upline]||{}).name||''; }
     toast('Moved \u2713 reloading the tree\u2026');
     reloadTree();
   })
   .catch(function(){ toast('Network error.'); MOVING=prev; paintBubbles(); });
}
function reloadTree(){
  fetch(ORGAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'tree',code:CODE})})
   .then(function(r){return r.json();})
   .then(function(t){
     if(!t||!t.ok)return;
     NODES=(t.nodes||[]).slice(); CANEDIT=!!t.can_edit_hierarchy; SCOPE=t.scope||SCOPE;
     BYCODE={};KIDS={};
     NODES.forEach(function(n){n.code=(n.code||'').toUpperCase();BYCODE[n.code]=n;});
     NODES.forEach(function(n){var p=(n.direct_to||'').toUpperCase();if(p&&BYCODE[p])(KIDS[p]=KIDS[p]||[]).push(n);});
     ROOTS=(t.roots||[]).map(function(r){return (typeof r==='string')?r:r.code;})
             .map(function(c){return (c||'').toUpperCase();}).filter(function(c){return !!BYCODE[c];});
     if(!ROOTS.length){ROOTS=NODES.filter(function(n){var p=(n.direct_to||'').toUpperCase();return !p||!BYCODE[p];}).map(function(n){return n.code;});}
     paintBubbles();
   });
}
function collapseDeep(){COLLAPSED={};NODES.forEach(function(n){if(depthOf(n.code)>=1&&(KIDS[n.code]||[]).length)COLLAPSED[n.code]=true;});paintBubbles();centreMap();}
function focusOn(code){
  /* Framing the whole company every time a branch opens just shrinks everyone. Opening a team
     frames THAT team at a readable size; the rest is still there to pan to. */
  var st=$('stage');if(!st)return;
  var laid=layout(), xs=[], ys=[];
  (function collect(c){var p=POS[c]||laid[c];if(p){xs.push(p.x);ys.push(p.y);}
    visibleKids(c).forEach(function(k){collect(k.code);});})(code);
  var parent=(BYCODE[code]&&(BYCODE[code].direct_to||'').toUpperCase());
  if(parent&&(POS[parent]||laid[parent])){var pp=POS[parent]||laid[parent];xs.push(pp.x);ys.push(pp.y);}
  if(!xs.length)return fitToView();
  var pad=150;
  var minX=Math.min.apply(null,xs)-pad, maxX=Math.max.apply(null,xs)+pad;
  var minY=Math.min.apply(null,ys)-pad, maxY=Math.max.apply(null,ys)+pad;
  var r=st.getBoundingClientRect();
  ZOOM=clampZ(Math.min(r.width/(maxX-minX), r.height/(maxY-minY), 1.25));
  PAN.x=r.width/2-((minX+maxX)/2)*ZOOM;
  PAN.y=r.height/2-((minY+maxY)/2)*ZOOM;
  applyTransform();saveLayout();
}
function toggleBranch(code){
  var opening=!COLLAPSED[code];
  COLLAPSED[code]=!COLLAPSED[code];
  paintBubbles();
  if(opening)focusOn(code); else fitToView();
}
function toggleTag(id){var i=ACTIVETAGS.indexOf(id);if(i>=0)ACTIVETAGS.splice(i,1);else ACTIVETAGS.push(id);renderMap();}
var saveT=null;
function saveLayout(){
  if(saveT)clearTimeout(saveT);
  saveT=setTimeout(function(){
    fetch(SUMAPI,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'layout_save',code:CODE,positions:POS,zoom:ZOOM})}).catch(function(){});
  },900);
}
function wireStage(){
  var st=$('stage');if(!st)return;
  st.addEventListener('wheel',function(e){
    e.preventDefault();
    var before=ZOOM; ZOOM=clampZ(ZOOM-e.deltaY*0.0016);
    var r=st.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
    PAN.x=mx-(mx-PAN.x)*(ZOOM/before); PAN.y=my-(my-PAN.y)*(ZOOM/before);
    applyTransform();saveLayout();
  },{passive:false});
  st.addEventListener('pointerdown',function(e){
    var b=e.target.closest?e.target.closest('.bub'):null;
    if(b&&!e.target.closest('.tog')){
      var code=b.getAttribute('data-code');
      var laid=layout(); var cur=POS[code]||laid[code];
      DRAG={kind:'node',code:code,sx:e.clientX,sy:e.clientY,ox:cur.x,oy:cur.y,moved:false};
      b.classList.add('dragging');
    } else if(!b){
      DRAG={kind:'canvas',sx:e.clientX,sy:e.clientY,ox:PAN.x,oy:PAN.y,moved:false};
      st.classList.add('grabbing');
    }
    if(DRAG)st.setPointerCapture(e.pointerId);
  });
  st.addEventListener('pointermove',function(e){
    if(!DRAG)return;
    var dx=e.clientX-DRAG.sx, dy=e.clientY-DRAG.sy;
    if(Math.abs(dx)>3||Math.abs(dy)>3)DRAG.moved=true;
    if(DRAG.kind==='canvas'){PAN.x=DRAG.ox+dx;PAN.y=DRAG.oy+dy;applyTransform();}
    else{
      POS[DRAG.code]={x:DRAG.ox+dx/ZOOM,y:DRAG.oy+dy/ZOOM};
      var el=$('plane').querySelector('.bub[data-code="'+DRAG.code+'"]');
      if(el){el.style.left=POS[DRAG.code].x+'px';el.style.top=POS[DRAG.code].y+'px';}
      redrawWires();
    }
  });
  function endDrag(){
    if(!DRAG)return;
    var wasNode=DRAG.kind==='node', moved=DRAG.moved, code=DRAG.code;
    DRAG=null;
    st.classList.remove('grabbing');
    var d=$('plane').querySelector('.bub.dragging');if(d)d.classList.remove('dragging');
    if(wasNode&&moved){saveLayout();}
    if(wasNode&&!moved&&code){/* a tap, not a drag */}
  }
  st.addEventListener('pointerup',endDrag);
  st.addEventListener('pointercancel',endDrag);
  setTimeout(fitToView,30);
}
function redrawWires(){
  var laid=layout(), lines='';
  Object.keys(laid).forEach(function(code){
    visibleKids(code).forEach(function(c){
      var a=POS[code]||laid[code], b=POS[c.code]||laid[c.code];
      if(!a||!b)return;
      lines+='<line x1="'+a.x.toFixed(1)+'" y1="'+a.y.toFixed(1)+'" x2="'+b.x.toFixed(1)+'" y2="'+b.y.toFixed(1)
        +'" stroke="rgba(242,209,122,.5)" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    });
  });
  var s=$('wires');if(s)s.innerHTML=lines;
}

/* ===== agent drawer ============================================================= */
function openAgent(code){
  if(DRAG)return;
  var n=BYCODE[code];if(!n)return;
  var rk=rankOf(n), prod=BOARD.production[code]||{points:0,deals:0};
  var tags=shownTagsOf(code).map(function(id){
    var t=BOARD.tags.filter(function(x){return x.id===id;})[0];return t?t.label:id;});
  var manage=BOARD.can_manage?('<button class="ghost" onclick="openTagsFor(\''+esc(code)+'\')">Manage this agent’s tags</button>'):'';
  $('drawer').innerHTML='<h3>'+esc(n.name||code)+'</h3>'
    +'<p class="dsub">'+esc(rk?rk.short:'Rank pending')+' · '+esc(n.baseshop||'—')+'</p>'
    +'<div class="fld"><label>Reports to</label><div>'+esc(n.direct_to_name||'—')+'</div></div>'
    +'<div class="fld"><label>Team</label><div>'+(n.directs||0)+' direct · '+(n.downline_total||0)+' total</div></div>'
    +'<div class="fld"><label>Submitted production</label><div>'+fmtPts(prod.points)+' points across '+(prod.deals||0)+' deals</div></div>'
    +(tags.length?'<div class="fld"><label>Tags</label><div>'+esc(tags.join(' · '))+'</div></div>':'')
    +'<button class="go" onclick="closeDrawer();LADDER=\''+esc(code)+'\';setTab(\'road\')">View Road to EMD</button>'
    +manage
    +'<button class="ghost" onclick="closeDrawer()">Close</button>';
  $('ov').classList.add('on');
}

/* ===== TOP PERFORMERS =========================================================== */
function renderPerf(){
  var rows=Object.keys(BOARD.production).map(function(code){
    var n=BYCODE[code];
    return {code:code,name:n?n.name:code,rank:rankOf(n),base:n?n.baseshop:'',
            photo:n&&n.has_photo,pts:BOARD.production[code].points,deals:BOARD.production[code].deals};
  }).filter(function(r){return r.pts>0;}).sort(function(a,b){return b.pts-a.pts;});
  var body=rows.length?rows.map(function(r,i){
    return '<div class="prow'+(i===0?' top1':'')+'">'
      +'<div class="pplace">'+(i+1)+'</div>'
      +'<div class="pini">'+(r.photo?'<img src="'+AVATAR+'?code='+encodeURIComponent(r.code)+'" alt="" loading="lazy">':esc(initials(r.name)))+'</div>'
      +'<div style="min-width:0"><div style="font-weight:700;font-size:14.5px">'+esc(r.name)+'</div>'
      +'<div class="brk '+(r.rank?r.rank.cls:'rank-pending')+'">'+esc(r.rank?r.rank.short:'Rank pending')+(r.base?(' · '+esc(r.base)):'')+'</div></div>'
      +'<div class="ppts"><b>'+Math.round(r.pts).toLocaleString()+'</b><small>'+r.deals+' deal'+(r.deals===1?'':'s')+'</small></div>'
      +'</div>';
  }).join(''):'<div class="empty">No submitted production recorded yet.</div>';
  $('view').innerHTML='<div class="panel" style="margin-top:8px">'
    +'<div class="eyebrow">Personal submitted production</div><h1 class="big">Top Performers</h1>'
    +'<p class="muted" style="margin:8px 0 18px;font-size:13px">Straight from New Business. On a split, each side is credited their own share — never both.</p>'
    +body+'</div>';
}

/* ===== ROAD TO EMD ============================================================== */
function ladderAgents(){
  var out=NODES.slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'');});
  return out;
}
/* Stages the platform can already prove for this agent: rank, the licensing board, the steps
   they ticked in My Tracker, and logged field trainings. Per stage rather than a single floor —
   somebody can have ten field trainings done and still not have passed the exam. */
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
function stageIndexById(id){for(var i=0;i<LADDER.length;i++)if(LADDER[i].id===id)return i;return -1;}
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
  var s=LADDER[i]; if(!s||!s.paths)return null;
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
}function stagesDone(code){var n=0;for(var i=0;i<STAGES.length;i++)if(stageComplete(code,i))n++;return n;}

var fail=0;
function eq(got,want,what){
  if(JSON.stringify(got)!==JSON.stringify(want)){fail++;console.log('FAIL: '+what+' -> got '+JSON.stringify(got)+' want '+JSON.stringify(want));}
}
function counts(){
  var out=[];
  for(var i=0;i<LADDER.length;i++){
    var st=LADDER[i];
    if(st.paths){ var p=[]; st.paths.forEach(function(x){p.push(x.reqs.length);}); out.push('alt'+p.join('/')); }
    else out.push(st.reqs.length);
  }
  return out;
}
eq(LADDER.length,20,'twenty stages');
eq(LADDER[19].title,'Senior Partner','stage 20 is Senior Partner');
eq(LADDER[0].title,'ICA','stage 1 is ICA');
eq(counts(),[3,5,4,6,10,3,3,3,2,5,'alt3/2',1,3,1,'alt5/5',4,4,3,4,4],'requirement counts per stage');
eq(stagesDone('NOBODY'),0,'an agent with no evidence clears nothing');

var MD=stageIndexById('md_promo');
BOARD.checks['A']={};
BOARD.checks['A']['md_promo.opt1.points45k']=true;
BOARD.checks['A']['md_promo.opt1.net5']=true;
eq(stageComplete('A',MD),false,'2 of 3 on Option 1 does not qualify');
BOARD.checks['A']['md_promo.opt2.cash50k']=true;
eq(stageComplete('A',MD),false,'partial Option 1 + partial Option 2 never qualifies');
BOARD.checks['A']['md_promo.opt2.lic10']=true;
eq(stageComplete('A',MD),true,'Option 2 alone qualifies');
eq(stageCount('A',MD),{done:2,total:2},'counter shows the qualifying path, not a 4/5 blend');

var EMD=stageIndexById('emd');
BOARD.checks['B']={};
['points150k_6mo','ring100k','watch_md','second_leg'].forEach(function(k){BOARD.checks['B']['emd.path1.'+k]=true;});
eq(stageComplete('B',EMD),false,'EMD Path 1 without 85% persistency does not qualify');
BOARD.checks['B']['emd.path1.persist85']=true;
eq(stageComplete('B',EMD),true,'EMD Path 1 complete qualifies');
eq(stageCount('B',EMD),{done:5,total:5},'EMD counter is 5/5, never 5/10');

BOARD.derived['ELI']={upto:'nvp',reqs:{}};
eq(isDerived('ELI',stageIndexById('nvp')),true,'NVP clears the NVP stage');
eq(isDerived('ELI',stageIndexById('leaders_council')),false,'NVP does NOT clear Leaders Council');
eq(isDerived('ELI',19),false,'NVP does NOT clear Senior Partner');
eq(stagesDone('ELI'),17,'NVP shows 17 of 20, not 20 of 20');
BOARD.derived['E2']={upto:'emd',reqs:{}};
eq(stagesDone('E2'),15,'EMD shows 15 of 20');

BOARD.derived['LIC']={upto:null,reqs:{'net_license.lic_appt':true,'senior_assoc.pass_exam':true}};
eq(reqDone('LIC',stageIndexById('net_license'),'net_license.lic_appt'),true,'licensed+appointed is derived');
eq(stageComplete('LIC',stageIndexById('net_license')),false,'Get Your Net License still needs Make $1,000');
eq(stageComplete('LIC',stageIndexById('appts')),false,'licensing proves nothing about appointments');

var keys={},dupes=0,bad=0,total=0;
for(var i=0;i<LADDER.length;i++){
  reqsOf(i).forEach(function(r){
    total++;
    if(keys[r.key])dupes++;
    keys[r.key]=1;
    if(!/^[a-z0-9_]+\.[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(r.key))bad++;
  });
}
eq(dupes,0,'no duplicate requirement ids');
eq(bad,0,'every id matches the pattern the server enforces');
console.log(fail ? (fail+' FAILURES') : 'ALL PASS - '+total+' requirements across 20 stages');
