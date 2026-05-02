// Insights screens: Reconciliation, POS imports, Audit log, Reports.

const { Card, Caption, StatTile, Pill } = window.cmdScreensShared;

// =================================================================
// 9. RECONCILIATION — variance report (counted vs expected)
// =================================================================
const ScreenReconciliation = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const rows = [
    { id:'i03', name:'Atlantic salmon',  expected:'5.6 lb',  counted:'4.2 lb',  diff:-1.4, dollar:-19.88, pct:-25, cat:'Seafood' },
    { id:'i05', name:'Romaine hearts',   expected:'8 ea',    counted:'0 ea',    diff:-8.0, dollar:-14.40, pct:-100,cat:'Produce' },
    { id:'i06', name:'Heavy cream',      expected:'5.2 qt',  counted:'6.0 qt',  diff:0.8,  dollar: 3.52,  pct:15,  cat:'Dairy'   },
    { id:'i01', name:'Beef tenderloin',  expected:'13.0 lb', counted:'12.4 lb', diff:-0.6, dollar:-13.44, pct:-5,  cat:'Protein' },
    { id:'i12', name:'Maine lobster',    expected:'1.4 lb',  counted:'0 lb',    diff:-1.4, dollar:-39.20, pct:-100,cat:'Seafood' },
    { id:'i02', name:'Chicken thigh',    expected:'37.2 lb', counted:'38.0 lb', diff:0.8,  dollar: 3.84,  pct:2,   cat:'Protein' },
    { id:'i09', name:'Olive oil EV',     expected:'2.4 gal', counted:'2.1 gal', diff:-0.3, dollar:-11.40, pct:-13, cat:'Dry Goods' },
    { id:'i10', name:'Brioche buns',     expected:'40 ea',   counted:'36 ea',   diff:-4.0, dollar:-2.20,  pct:-10, cat:'Bakery'  },
  ];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg }}>
      <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
        {['variance.tsx','byCategory.tsx','timeline.tsx'].map((x,i)=>(
          <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
        ))}
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>EXPORT</div>
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>POST → COGS  ⏎</div>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
        <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Reconciliation · Apr 30</h1>
        <div style={{ fontSize:13, color:t.fg2, marginBottom:14 }}>Counted EOD vs expected from POS depletion + waste log + receiving. Post-shrink to GL when reviewed.</div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
          <StatTile t={t} label="ITEMS RECONCILED" value="24 / 24" sub="100% complete" tone="ok" />
          <StatTile t={t} label="NET VARIANCE" value="−$93.16" sub="0.5% of inventory" tone="warn" />
          <StatTile t={t} label="ITEMS OFF" value="6" sub="3 favorable · 3 short" />
          <StatTile t={t} label="LARGEST" value="−$39.20" sub="Maine lobster" tone="danger" />
        </div>

        <Caption t={t} right={`8 lines · sorted by |Δ$|`}>VARIANCE_REPORT.TSV</Caption>
        <Card t={t} style={{ padding:0 }}>
          <div style={{ display:'grid', gridTemplateColumns:'60px 1fr 100px 100px 90px 90px 70px 80px', padding:'8px 14px', borderBottom:`1px solid ${t.border}`, fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5 }}>
            <span>id</span><span>name</span><span>expected</span><span>counted</span><span>Δ qty</span><span>Δ $</span><span style={{textAlign:'right'}}>Δ %</span><span style={{textAlign:'right'}}>cat</span>
          </div>
          {rows.map((r,i)=>{
            const tone = Math.abs(r.pct) >= 25 ? t.danger : Math.abs(r.pct) >= 10 ? t.warn : (r.diff>0?t.ok:t.fg2);
            return (
              <div key={r.id} style={{ display:'grid', gridTemplateColumns:'60px 1fr 100px 100px 90px 90px 70px 80px', alignItems:'center', padding:'9px 14px', borderTop:i===0?'none':`1px solid ${t.border}` }}>
                <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{r.id}</span>
                <span style={{ fontSize:12.5, fontWeight:500 }}>{r.name}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{r.expected}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg, fontVariantNumeric:'tabular-nums' }}>{r.counted}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:tone, fontVariantNumeric:'tabular-nums' }}>{r.diff>0?'+':''}{r.diff}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:tone, fontVariantNumeric:'tabular-nums' }}>{r.dollar>0?'+':''}${Math.abs(r.dollar).toFixed(2)}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:tone, fontVariantNumeric:'tabular-nums', textAlign:'right' }}>{r.pct>0?'+':''}{r.pct}%</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, textAlign:'right' }}>{r.cat.toLowerCase()}</span>
              </div>
            );
          })}
          <div style={{ display:'grid', gridTemplateColumns:'60px 1fr 100px 100px 90px 90px 70px 80px', padding:'10px 14px', borderTop:`1px solid ${t.borderStrong}`, background:t.panel2, fontFamily:window.cmdMono, fontSize:11.5, fontWeight:700 }}>
            <span></span>
            <span style={{ color:t.fg3, textTransform:'uppercase', letterSpacing:0.5, fontSize:10 }}>NET · 8 LINES</span>
            <span></span><span></span>
            <span></span>
            <span style={{ color:t.warn, fontVariantNumeric:'tabular-nums' }}>−$93.16</span>
            <span style={{ textAlign:'right', color:t.warn, fontVariantNumeric:'tabular-nums' }}>−0.5%</span>
            <span></span>
          </div>
        </Card>
      </div>
    </div>
  );
};

// =================================================================
// 10. POS IMPORTS — list of imports with status
// =================================================================
const ScreenPOSImports = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const imports = [
    { id:'imp_2026-04-30_dinner', source:'Toast',   when:'12m',  rows:184, matched:182, errors:0, depletion:842.40, status:'success' },
    { id:'imp_2026-04-30_lunch',  source:'Toast',   when:'5h',   rows: 96, matched: 96, errors:0, depletion:412.10, status:'success' },
    { id:'imp_2026-04-30_brunch', source:'Toast',   when:'8h',   rows: 64, matched: 60, errors:4, depletion:218.60, status:'partial' },
    { id:'imp_2026-04-29_dinner', source:'Toast',   when:'1d',   rows:202, matched:202, errors:0, depletion:914.00, status:'success' },
    { id:'imp_2026-04-29_lunch',  source:'Toast',   when:'1d',   rows:108, matched:106, errors:2, depletion:438.20, status:'partial' },
    { id:'imp_2026-04-28_evt',    source:'Square',  when:'2d',   rows: 42, matched:  0, errors:42,depletion:  0,    status:'failed'  },
    { id:'imp_2026-04-28_dinner', source:'Toast',   when:'2d',   rows:178, matched:178, errors:0, depletion:798.40, status:'success' },
    { id:'imp_2026-04-28_lunch',  source:'Toast',   when:'2d',   rows: 92, matched: 92, errors:0, depletion:402.80, status:'success' },
  ];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg }}>
      <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
        {['imports.tsx','mapping.tsx','sources.tsx'].map((x,i)=>(
          <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
        ))}
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>UPLOAD CSV</div>
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>RUN IMPORT  ⌘I</div>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
        <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>POS imports</h1>
        <div style={{ fontSize:13, color:t.fg2, marginBottom:14 }}>Sales feeds depletion. Toast pulls every 30 min; Square is manual. Errors = SKU not mapped.</div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
          <StatTile t={t} label="LAST IMPORT" value="12m ago" sub="Toast · dinner" tone="ok" />
          <StatTile t={t} label="ROWS / 7D" value="2,148" sub="98.7% matched" />
          <StatTile t={t} label="UNMAPPED" value="48" sub="needs attention" tone="warn" />
          <StatTile t={t} label="FAILED" value="1" sub="Square evt 04-28" tone="danger" />
        </div>

        <Caption t={t} right="8 imports · last 7d">IMPORTS.LOG</Caption>
        <Card t={t} style={{ padding:0 }}>
          <div style={{ display:'grid', gridTemplateColumns:'40px 2fr 80px 70px 90px 90px 110px 90px', padding:'8px 14px', borderBottom:`1px solid ${t.border}`, fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5 }}>
            <span></span><span>id</span><span>source</span><span>when</span><span>rows</span><span>matched</span><span>depletion $</span><span style={{textAlign:'right'}}>state</span>
          </div>
          {imports.map((im,i)=>{
            const tone = im.status==='success'?'ok' : im.status==='partial'?'warn' : 'out';
            return (
              <div key={im.id} style={{ display:'grid', gridTemplateColumns:'40px 2fr 80px 70px 90px 90px 110px 90px', alignItems:'center', padding:'9px 14px', borderTop:i===0?'none':`1px solid ${t.border}`, background: im.status==='failed'?t.dangerBg : 'transparent' }}>
                <span style={{ fontFamily:window.cmdMono, fontSize:13, color: im.status==='success'?t.ok : im.status==='partial'?t.warn : t.danger }}>{im.status==='success'?'✓':im.status==='partial'?'!':'✕'}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, fontWeight:500, color:t.fg }}>{im.id}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg2 }}>{im.source}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{im.when}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg, fontVariantNumeric:'tabular-nums' }}>{im.rows}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color: im.errors?t.warn:t.fg, fontVariantNumeric:'tabular-nums' }}>{im.matched} {im.errors? <span style={{color:t.danger}}>(−{im.errors})</span> : null}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg, fontVariantNumeric:'tabular-nums' }}>${im.depletion.toFixed(2)}</span>
                <span style={{ textAlign:'right' }}><Pill t={t} status={tone}>{im.status}</Pill></span>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
};

// =================================================================
// 11. AUDIT LOG — chronological feed
// =================================================================
const ScreenAuditLog = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const day = (label, events) => ({ label, events });
  const days = [
    day('TODAY · MAY 1', [
      { t:'14:08', who:'AD', name:'Admin',          action:'received PO',           target:'Sysco PO-4821',         tone:'ok'    },
      { t:'13:42', who:'AR', name:'Ana Rivera',     action:'imported POS',          target:'toast_2026-04-30_dinner', tone:'info'  },
      { t:'12:28', who:'JT', name:'James Thompson', action:'logged waste',          target:'1.2 lb Atlantic salmon · spoilage', tone:'warn'},
      { t:'11:50', who:'AD', name:'Admin',          action:'updated par_level',     target:'Heirloom tomato · 18 → 20', tone:'fg2' },
      { t:'08:14', who:'MG', name:'Maria Garcia',   action:'submitted EOD count',   target:'24 items · variance −$93', tone:'info' },
    ]),
    day('YESTERDAY · APR 30', [
      { t:'22:08', who:'JT', name:'James Thompson', action:'logged waste',          target:'0.8 qt heavy cream · expired', tone:'warn' },
      { t:'18:30', who:'AD', name:'Admin',          action:'sent PO',               target:'Lancaster PO-4820 · $318',   tone:'info' },
      { t:'14:02', who:'AR', name:'Ana Rivera',     action:'created vendor',        target:'Trickling Springs Dairy',     tone:'fg2'  },
      { t:'10:14', who:'AD', name:'Admin',          action:'archived recipe',       target:'r-21 spring risotto',         tone:'fg2'  },
    ]),
    day('APR 29', [
      { t:'19:45', who:'AD', name:'Admin',          action:'sent PO',               target:'Samuels PO-4819 · $612',     tone:'info' },
      { t:'15:20', who:'MG', name:'Maria Garcia',   action:'submitted EOD count',   target:'24 items · variance −$41',   tone:'info' },
      { t:'09:08', who:'AD', name:'Admin',          action:'updated cost',          target:'Atlantic salmon · $13.80 → $14.20', tone:'fg2' },
    ]),
  ];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg }}>
      <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
        {['feed.tsx','byUser.tsx','byEntity.tsx'].map((x,i)=>(
          <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
        ))}
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>EXPORT</div>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
        <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Audit log</h1>
        <div style={{ fontSize:13, color:t.fg2, marginBottom:14 }}>Append-only event stream. Every state change is recorded with actor, entity, before/after.</div>

        <div style={{ display:'flex', alignItems:'center', gap:6, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, padding:'7px 12px', marginBottom:14 }}>
          <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>filter:</span>
          <span style={{ flex:1, fontFamily:window.cmdMono, fontSize:11, color:t.fg }}>actor:* entity:* action:*<span style={{ color:t.accent }}>▍</span></span>
          <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>3 days · 12 events</span>
        </div>

        {days.map(d => (
          <div key={d.label} style={{ marginBottom:18 }}>
            <div style={{ fontFamily:window.cmdMono, fontSize:10, fontWeight:700, color:t.fg3, textTransform:'uppercase', letterSpacing:0.6, marginBottom:8 }}>{d.label}</div>
            <Card t={t} style={{ padding:'4px 14px' }}>
              {d.events.map((e,i) => {
                const tone = e.tone==='ok'?t.ok : e.tone==='warn'?t.warn : e.tone==='danger'?t.danger : e.tone==='info'?t.info : t.fg2;
                return (
                  <div key={i} style={{ display:'grid', gridTemplateColumns:'56px 22px 160px 1fr 8px', alignItems:'center', padding:'9px 0', borderTop:i===0?'none':`1px dashed ${t.border}`, gap:10 }}>
                    <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{e.t}</span>
                    <span style={{ width:18, height:18, borderRadius:99, background:t.accentBg, color:t.accent, fontFamily:window.cmdMono, fontSize:9, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>{e.who}</span>
                    <span style={{ fontSize:12.5, fontWeight:600 }}>{e.name}</span>
                    <span style={{ fontSize:12.5, color:t.fg2 }}>{e.action} <span style={{ color:t.fg }}>{e.target}</span></span>
                    <span style={{ width:6, height:6, borderRadius:99, background:tone }} />
                  </div>
                );
              })}
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
};

// =================================================================
// 12. REPORTS — pre-built reports grid
// =================================================================
const ScreenReports = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const reports = [
    { id:'r-01', name:'Food cost trend',     desc:'COGS % vs target over 90d',    schedule:'weekly', owner:'AD', updated:'12m', sample:'31.4%',  tone:'warn' },
    { id:'r-02', name:'Top movers',          desc:'Items by qty depleted (7d)',   schedule:'on-demand', owner:'AD', updated:'2h', sample:'salmon' },
    { id:'r-03', name:'Waste analysis',      desc:'$ + reasons by category',      schedule:'weekly', owner:'AD', updated:'1d', sample:'$412/wk', tone:'warn' },
    { id:'r-04', name:'Vendor scorecard',    desc:'On-time, cost, quality',       schedule:'monthly', owner:'AD', updated:'5d', sample:'96% OTD', tone:'ok' },
    { id:'r-05', name:'Recipe profitability',desc:'Margin × volume',              schedule:'on-demand', owner:'AD', updated:'1d', sample:'salmon top' },
    { id:'r-06', name:'Variance summary',    desc:'EOD shrink trends',            schedule:'daily',  owner:'AD', updated:'8h', sample:'−0.5%',  tone:'warn' },
    { id:'r-07', name:'Inventory aging',     desc:'Days on hand by category',     schedule:'weekly', owner:'AD', updated:'2d', sample:'4.2d avg' },
    { id:'r-08', name:'Reorder forecast',    desc:'Predicted needs (14d)',        schedule:'daily',  owner:'AD', updated:'1h', sample:'$2,148' },
  ];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg }}>
      <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
        {['library.tsx','scheduled.tsx','custom.tsx'].map((x,i)=>(
          <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
        ))}
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>+ NEW REPORT  ⌘N</div>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
        <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Reports</h1>
        <div style={{ fontSize:13, color:t.fg2, marginBottom:18 }}>Pre-built dashboards. Click a tile to open; ⌘D to duplicate as a custom report you can edit.</div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:14 }}>
          {reports.map(r => (
            <Card key={r.id} t={t}>
              <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6 }}>
                <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{r.id}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:9.5, fontWeight:700, padding:'2px 7px', borderRadius:3, background:t.panel2, color:t.fg2, textTransform:'uppercase', letterSpacing:0.5 }}>{r.schedule}</span>
              </div>
              <div style={{ fontSize:15, fontWeight:700, letterSpacing:-0.2, marginBottom:4 }}>{r.name}</div>
              <div style={{ fontSize:12.5, color:t.fg2, marginBottom:10 }}>{r.desc}</div>
              <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', borderTop:`1px dashed ${t.border}`, paddingTop:10 }}>
                <span style={{ fontFamily:window.cmdMono, fontSize:18, fontWeight:600, color: r.tone==='warn'?t.warn : r.tone==='ok'?t.ok : t.fg, fontVariantNumeric:'tabular-nums', letterSpacing:-0.3 }}>{r.sample}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>updated {r.updated} · {r.owner}</span>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};

window.ScreenReconciliation = ScreenReconciliation;
window.ScreenPOSImports = ScreenPOSImports;
window.ScreenAuditLog = ScreenAuditLog;
window.ScreenReports = ScreenReports;
