// Mobile Command — Command direction reflowed for iPhone (402×874).
// Three screens × two roles (admin, staff). Staff role removes:
//   • costs, stock value, food-cost, vendor contact details
//   • Edit / Restock / PO actions
//   • Audit tab, Insights nav group, Planning items they don't own
//   • activity_log restricted to "your activity"
//   • ⌘K palette scope limited to items + recipes (no audit / vendors)

const useCmdTheme = (dark) => dark ? {
  bg:'#08090C', panel:'#0E1014', panel2:'#181B22', border:'rgba(255,255,255,0.06)', borderStrong:'rgba(255,255,255,0.12)',
  fg:'#E6E8EC', fg2:'#9BA0AB', fg3:'#5C6270',
  accent:'oklch(0.78 0.16 145)', accentBg:'oklch(0.30 0.08 145 / 0.4)',
  ok:'#5CB832', warn:'#E0A030', danger:'#E04848', info:'#5AA8F0',
  okBg:'rgba(92,184,50,0.15)', warnBg:'rgba(224,160,48,0.15)', dangerBg:'rgba(224,72,72,0.15)',
} : {
  bg:'#FAFAF8', panel:'#FFFFFF', panel2:'#F4F4F0', border:'rgba(20,20,20,0.07)', borderStrong:'rgba(20,20,20,0.14)',
  fg:'#0E1014', fg2:'#5A5F68', fg3:'#9094A0',
  accent:'oklch(0.50 0.16 145)', accentBg:'oklch(0.93 0.06 145 / 1)',
  ok:'#3B6D11', warn:'#854F0B', danger:'#791F1F', info:'#185FA5',
  okBg:'#EAF3DE', warnBg:'#FAEEDA', dangerBg:'#FCEBEB',
};

const SANS = '"Inter Tight", "Inter", -apple-system, system-ui, sans-serif';
const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, monospace';

// Role badge — small mono pill in the title bar so the role is unmistakable
const RoleBadge = ({ role, t }) => {
  const isAdmin = role === 'admin';
  return (
    <span style={{
      fontFamily:MONO, fontSize:9.5, fontWeight:700, padding:'2px 6px', borderRadius:3,
      letterSpacing:0.5, textTransform:'uppercase', whiteSpace:'nowrap', flexShrink:0,
      background: isAdmin ? t.accentBg : t.panel2,
      color: isAdmin ? t.accent : t.fg2,
      border: `1px solid ${isAdmin ? t.accent : t.border}`,
    }}>{isAdmin ? '◆ admin' : '○ staff'}</span>
  );
};

// ────────────────────────────────────────────────────────────────────
// SCREEN 1 — Inventory list
// ────────────────────────────────────────────────────────────────────
const MobileCmdList = ({ dark, role = 'admin' }) => {
  const t = useCmdTheme(dark);
  const isAdmin = role === 'admin';
  const { INVENTORY } = window.IM_DATA;

  const chips = isAdmin
    ? [['all','12'], ['ok','7'], ['low','3'], ['out','2'], ['protein','3'], ['produce','3']]
    : [['to count','12'], ['low','3'], ['out','2'], ['my zone','6']];

  const userName = isAdmin ? 'admin' : 'maria.g';

  return (
    <div style={{ width:'100%', height:'100%', background:t.bg, color:t.fg, fontFamily:SANS, display:'flex', flexDirection:'column' }}>
      <div style={{ paddingTop:54, paddingBottom:10, paddingLeft:16, paddingRight:16, background:t.panel, borderBottom:`1px solid ${t.border}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
          <span style={{ width:18, height:18, fontSize:18, color:t.fg2, lineHeight:1 }}>☰</span>
          <div style={{ flex:1, fontFamily:MONO, fontSize:11, color:t.fg3, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis' }}>
            inv://towson <span style={{color:t.fg2}}>— {isAdmin?'inventory':'count_queue'}</span>
          </div>
          <RoleBadge role={role} t={t} />
        </div>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10 }}>
          <h1 style={{ margin:0, fontSize:24, fontWeight:700, letterSpacing:-0.4, whiteSpace:'nowrap' }}>{isAdmin ? 'Inventory' : 'Count queue'}</h1>
          <span style={{ fontFamily:MONO, fontSize:11, color:t.fg3 }}>{isAdmin ? `${INVENTORY.length} items` : '12 to do'}</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:6, padding:'7px 10px' }}>
          <span style={{ fontFamily:MONO, fontSize:11, color:t.fg3 }}>filter:</span>
          <span style={{ flex:1, fontFamily:MONO, fontSize:11, color:t.fg, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis' }}>
            {isAdmin
              ? <>status:low cat:produce<span style={{ color:t.accent, animation:'cmdblink 1s steps(2) infinite' }}>▍</span></>
              : <>zone:line assigned:{userName}<span style={{ color:t.accent, animation:'cmdblink 1s steps(2) infinite' }}>▍</span></>
            }
          </span>
          <span style={{ fontFamily:MONO, fontSize:9.5, color:t.fg3, padding:'1px 5px', border:`1px solid ${t.border}`, borderRadius:3 }}>⌘K</span>
        </div>
        <div style={{ display:'flex', gap:6, marginTop:10, overflowX:'auto', paddingBottom:2 }}>
          {chips.map(([k,n],i) => (
            <span key={k} style={{
              padding:'4px 9px', fontFamily:MONO, fontSize:10.5, fontWeight:600, borderRadius:99,
              background: i===0?t.accentBg:t.panel2, border:`1px solid ${i===0?t.accent:t.border}`,
              color: i===0?t.fg:t.fg2, whiteSpace:'nowrap', display:'flex', gap:5, alignItems:'center'
            }}>{k} <span style={{ color:t.fg3 }}>{n}</span></span>
          ))}
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto' }}>
        {INVENTORY.map((it,i) => {
          const sel = it.id === 'i03';
          const tone = it.status==='out'?t.danger:it.status==='low'?t.warn:t.ok;
          const ratio = it.par > 0 ? Math.min(it.stock/it.par, 1) : 0;
          return (
            <div key={it.id} style={{
              padding:'12px 16px', borderBottom:`1px solid ${t.border}`,
              background: sel ? t.accentBg : 'transparent',
              borderLeft: sel ? `3px solid ${t.accent}` : '3px solid transparent',
            }}>
              <div style={{ display:'flex', alignItems:'center', gap:9, marginBottom:6 }}>
                <span style={{ width:7, height:7, borderRadius:99, background:tone, flexShrink:0 }} />
                <span style={{ fontWeight:600, fontSize:14, flex:1 }}>{it.name}</span>
                <span style={{ fontFamily:MONO, fontSize:10, color:t.fg3 }}>{it.id}</span>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:9, fontSize:12, color:t.fg2 }}>
                <span style={{ fontFamily:MONO, fontVariantNumeric:'tabular-nums', minWidth:74 }}>{it.stock.toFixed(1)}/{it.par} <span style={{color:t.fg3}}>{it.unit}</span></span>
                <div style={{ flex:1, height:3, background:t.panel2, borderRadius:99, overflow:'hidden' }}>
                  <div style={{ width:`${ratio*100}%`, height:'100%', background:tone }} />
                </div>
                <span style={{ color:t.fg3, fontSize:11, minWidth:54, textAlign:'right' }}>{it.cat}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ borderTop:`1px solid ${t.border}`, background:t.panel, padding:'8px 12px 28px', display:'flex', alignItems:'center', gap:10, fontFamily:MONO, fontSize:10.5, color:t.fg3, flexShrink:0 }}>
        <span>● synced</span>
        <span>{isAdmin ? '12 / 142' : '12 / 12'}</span>
        <span style={{ flex:1 }} />
        <span style={{ color:t.accent, fontWeight:600 }}>+ COUNT</span>
      </div>
      <style>{`@keyframes cmdblink{50%{opacity:0}}`}</style>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────
// SCREEN 2 — Item detail
// ────────────────────────────────────────────────────────────────────
const MobileCmdDetail = ({ dark, role = 'admin' }) => {
  const t = useCmdTheme(dark);
  const isAdmin = role === 'admin';
  const { INVENTORY, RECENT_ACTIVITY } = window.IM_DATA;
  const item = INVENTORY.find(i => i.id === 'i03');

  // Tabs differ by role: staff doesn't see audit
  const tabs = isAdmin
    ? ['detail.tsx','usage.tsx','audit.tsx','recipes.tsx']
    : ['detail.tsx','count.tsx','recipes.tsx'];

  // Stat grid differs by role: staff doesn't see cost / value
  const stats = isAdmin ? [
    ['On hand',  `${item.stock.toFixed(1)} ${item.unit}`, `par ${item.par}`],
    ['Cost / unit', `$${item.cost.toFixed(2)}`,            'avg L7d'],
    ['Stock value', `$${(item.stock*item.cost).toFixed(0)}`, 'at current cost'],
    ['Days cover', `${(item.stock/2.4).toFixed(1)}d`, 'at avg usage'],
  ] : [
    ['On hand',  `${item.stock.toFixed(1)} ${item.unit}`, `par ${item.par}`],
    ['Last count', `4.2 ${item.unit}`,                    'by you · 1h'],
    ['Variance', `−1.4 ${item.unit}`,                     'vs expected'],
    ['Days cover', `${(item.stock/2.4).toFixed(1)}d`,     'at avg usage'],
  ];

  // Properties differ by role: staff doesn't see cost or vendor pricing fields
  const props = isAdmin ? [
    ['category', `"${item.cat}"`],
    ['unit', `"${item.unit}"`],
    ['vendor', `"${item.vendor}"`],
    ['cost_per_unit', `$${item.cost.toFixed(2)}`],
    ['par_level', item.par],
    ['avg_daily_usage', '2.4'],
    ['lead_time_days', '2'],
  ] : [
    ['category', `"${item.cat}"`],
    ['unit', `"${item.unit}"`],
    ['par_level', item.par],
    ['storage', `"walk-in 1 / shelf B"`],
    ['count_freq', `"daily"`],
    ['allergens', `["fish"]`],
  ];

  return (
    <div style={{ width:'100%', height:'100%', background:t.bg, color:t.fg, fontFamily:SANS, display:'flex', flexDirection:'column' }}>
      <div style={{ paddingTop:54, paddingBottom:8, paddingLeft:14, paddingRight:14, background:t.panel, borderBottom:`1px solid ${t.border}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <span style={{ fontFamily:MONO, fontSize:13, color:t.accent, fontWeight:600 }}>‹ {isAdmin?'inventory':'count_queue'}</span>
          <div style={{ flex:1, textAlign:'center', fontFamily:MONO, fontSize:10.5, color:t.fg3 }}>{item.id}.tsx</div>
          <RoleBadge role={role} t={t} />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', background:t.panel, borderBottom:`1px solid ${t.border}`, padding:'0 4px', flexShrink:0 }}>
        {tabs.map((x,i) => (
          <div key={x} style={{
            flex:1, padding:'8px 4px', fontFamily:MONO, fontSize:10.5, fontWeight:500, textAlign:'center',
            color: i===0 ? t.fg : t.fg2,
            borderBottom: i===0 ? `2px solid ${t.accent}` : '2px solid transparent',
          }}>{x}</div>
        ))}
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'14px 14px 16px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
          <span style={{ fontFamily:MONO, fontSize:11, color:t.fg3 }}>{item.id}</span>
          <span style={{ fontFamily:MONO, fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:3, color:t.warn, background:t.warnBg, textTransform:'uppercase', letterSpacing:0.5 }}>LOW</span>
        </div>
        <h1 style={{ margin:0, fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>{item.name}</h1>
        <div style={{ fontSize:12, color:t.fg2, marginTop:3 }}>
          {item.cat} · {isAdmin ? <>{item.vendor} · {item.updated} ago</> : <>walk-in 1 · {item.updated} ago</>}
        </div>

        {/* Action buttons — staff sees only COUNT + flag; admin sees COUNT + EDIT + more */}
        <div style={{ display:'flex', gap:8, marginTop:14 }}>
          <button style={{ flex:1, background:t.accent, color:'#000', border:0, borderRadius:5, padding:'10px 0', fontFamily:MONO, fontSize:11, fontWeight:700, letterSpacing:0.5 }}>+ COUNT</button>
          {isAdmin ? (
            <>
              <button style={{ flex:1, background:'transparent', color:t.fg2, border:`1px solid ${t.borderStrong}`, borderRadius:5, padding:'10px 0', fontFamily:MONO, fontSize:11, fontWeight:700, letterSpacing:0.5 }}>EDIT</button>
              <button style={{ width:46, background:'transparent', color:t.fg2, border:`1px solid ${t.borderStrong}`, borderRadius:5, padding:'10px 0', fontFamily:MONO, fontSize:13, fontWeight:700 }}>⌥</button>
            </>
          ) : (
            <button style={{ flex:1, background:'transparent', color:t.fg2, border:`1px solid ${t.borderStrong}`, borderRadius:5, padding:'10px 0', fontFamily:MONO, fontSize:11, fontWeight:700, letterSpacing:0.5 }}>FLAG ISSUE</button>
          )}
        </div>

        {/* Stat grid */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:14 }}>
          {stats.map(([l,v,s],i) => (
            <div key={i} style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:'11px 12px' }}>
              <div style={{ fontFamily:MONO, fontSize:9, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5, marginBottom:4 }}>{l}</div>
              <div style={{ fontFamily:MONO, fontSize:18, fontWeight:600, fontVariantNumeric:'tabular-nums', letterSpacing:-0.3 }}>{v}</div>
              <div style={{ fontFamily:MONO, fontSize:9.5, color:t.fg3, marginTop:2 }}>{s}</div>
            </div>
          ))}
        </div>

        {/* Stock chart */}
        <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:12, marginTop:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <div style={{ fontFamily:MONO, fontSize:9.5, fontWeight:600, color:t.fg2, textTransform:'uppercase', letterSpacing:0.6 }}>stock_history.dat — {isAdmin?'14d':'7d'}</div>
            <div style={{ fontFamily:MONO, fontSize:9.5, color:t.fg3 }}>par={item.par}</div>
          </div>
          {(() => {
            const full = [16,15,14,16,18,17,15,13,11,10,9,7,6, item.stock];
            const data = isAdmin ? full : full.slice(-7);
            const w=340, h=100, max=Math.max(...data, item.par+2);
            const pts = data.map((v,i) => `${(i/(data.length-1))*w},${h - (v/max)*h}`);
            return (
              <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
                {[0,0.5,1].map((g,i) => <line key={i} x1="0" x2={w} y1={g*h} y2={g*h} stroke={t.border} strokeDasharray="2 4" />)}
                <line x1="0" x2={w} y1={h-(item.par/max)*h} y2={h-(item.par/max)*h} stroke={t.warn} strokeDasharray="3 3" strokeWidth="1" />
                <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={t.accent} fillOpacity="0.15" />
                <polyline points={pts.join(' ')} fill="none" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                {pts.map((p,i) => { const [x,y]=p.split(','); return <circle key={i} cx={x} cy={y} r={i===pts.length-1?3:1.5} fill={t.accent} />; })}
              </svg>
            );
          })()}
          <div style={{ display:'flex', gap:14, marginTop:8, fontFamily:MONO, fontSize:9.5, color:t.fg3 }}>
            <span><span style={{display:'inline-block', width:8, height:2, background:t.accent, marginRight:4, verticalAlign:'middle'}}/>on-hand</span>
            <span><span style={{display:'inline-block', width:8, height:1, background:t.warn, marginRight:4, verticalAlign:'middle'}}/>par</span>
            <span style={{ marginLeft:'auto', color:t.danger }}>↘ {isAdmin?'62%':'31%'}</span>
          </div>
        </div>

        {/* properties.json */}
        <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:12, marginTop:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <div style={{ fontFamily:MONO, fontSize:9.5, fontWeight:600, color:t.fg2, textTransform:'uppercase', letterSpacing:0.6 }}>properties.json</div>
            {!isAdmin && (
              <span style={{ fontFamily:MONO, fontSize:8.5, color:t.fg3, padding:'1px 5px', border:`1px dashed ${t.border}`, borderRadius:3 }}>2 fields hidden</span>
            )}
          </div>
          <div style={{ fontFamily:MONO, fontSize:11, lineHeight:1.7 }}>
            {props.map(([k,v],i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'2px 0', borderBottom: i<props.length-1?`1px dashed ${t.border}`:'none' }}>
                <span style={{ color:t.fg3 }}>{k}</span>
                <span style={{ color:t.fg, fontVariantNumeric:'tabular-nums' }}>{v}</span>
              </div>
            ))}
            {!isAdmin && (
              <div style={{ display:'flex', justifyContent:'space-between', padding:'2px 0', opacity:0.5 }}>
                <span style={{ color:t.fg3 }}>cost_per_unit</span>
                <span style={{ color:t.fg3, fontStyle:'italic' }}>—  admin only</span>
              </div>
            )}
          </div>
        </div>

        {/* activity_log */}
        <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:12, marginTop:12 }}>
          <div style={{ fontFamily:MONO, fontSize:9.5, fontWeight:600, color:t.fg2, textTransform:'uppercase', letterSpacing:0.6, marginBottom:8 }}>
            {isAdmin ? 'activity_log' : 'your_activity'}
          </div>
          {(isAdmin ? RECENT_ACTIVITY.slice(0,3) : RECENT_ACTIVITY.filter(a => a.who === 'MG').slice(0,3)).map((a,i,arr) => (
            <div key={i} style={{ display:'flex', gap:9, alignItems:'center', padding:'7px 0', borderBottom: i<arr.length-1?`1px solid ${t.border}`:'none', fontSize:11.5 }}>
              <span style={{ fontFamily:MONO, fontSize:9.5, color:t.fg3, width:28 }}>{a.ago}</span>
              <span style={{ width:18, height:18, borderRadius:99, background:t.accentBg, color:t.accent, fontFamily:MONO, fontSize:9, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>{a.who}</span>
              <span style={{ color:t.fg2, flex:1 }}><span style={{color:t.fg, fontWeight:500}}>{isAdmin?a.name:'You'}</span> {a.action}</span>
            </div>
          ))}
          {!isAdmin && (
            <div style={{ marginTop:8, fontFamily:MONO, fontSize:10, color:t.fg3, textAlign:'center', padding:'4px 0' }}>
              · full audit log restricted to admins ·
            </div>
          )}
        </div>
      </div>

      <div style={{ borderTop:`1px solid ${t.border}`, background:t.panel, padding:'8px 12px 28px', display:'flex', alignItems:'center', gap:10, fontFamily:MONO, fontSize:10, color:t.fg3, flexShrink:0 }}>
        <span>● synced</span>
        <span>cat:{item.cat.toLowerCase()}</span>
        <span style={{ flex:1 }} />
        <span style={{ color:t.accent }}>⌘K</span>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────
// SCREEN 3 — Tree-nav drawer + ⌘K palette overlay
// ────────────────────────────────────────────────────────────────────
const MobileCmdNav = ({ dark, role = 'admin' }) => {
  const t = useCmdTheme(dark);
  const isAdmin = role === 'admin';
  const { KPIS } = window.IM_DATA;

  const tree = isAdmin ? [
    { name:'Operations', items:[
      ['Dashboard','D'], ['Inventory','I', true], ['EOD count','E'], ['Waste log','W'], ['Receiving','R']
    ]},
    { name:'Planning', items:[
      ['Purchase orders','P'], ['Vendors','V'], ['Recipes','C'], ['Restock','S']
    ]},
    { name:'Insights', items:[
      ['Reconciliation','N'], ['POS imports','M'], ['Audit log','A'], ['Reports','T']
    ]},
  ] : [
    { name:'Tasks', items:[
      ['Today','T'], ['Count queue','I', true], ['Log waste','W'], ['Receiving','R']
    ]},
    { name:'Reference', items:[
      ['Recipes','C'], ['How-to','H']
    ]},
  ];

  // Palette results differ by role
  const matches = isAdmin ? [
    ['item', 'Atlantic salmon', 'i03', t.warn, 'low'],
    ['recipe', 'Salmon crudo', 'r12', t.fg3, '6 ingr'],
    ['audit', 'logged waste 1.2 lb salmon', '38m', t.fg3, 'JT'],
  ] : [
    ['item', 'Atlantic salmon', 'i03', t.warn, 'low'],
    ['recipe', 'Salmon crudo', 'r12', t.fg3, '6 ingr'],
  ];

  const restricted = ['Vendors','Reports','Audit log','Reconciliation'];

  return (
    <div style={{ width:'100%', height:'100%', background:t.bg, color:t.fg, fontFamily:SANS, display:'flex', flexDirection:'column' }}>
      <div style={{ paddingTop:54, paddingBottom:12, paddingLeft:16, paddingRight:16, background:t.panel, borderBottom:`1px solid ${t.border}` }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
          <div style={{ width:26, height:26, borderRadius:5, background:t.accent, color:'#000', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:MONO, fontSize:14, fontWeight:700 }}>i</div>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:14 }}>im.cmd</div>
            <div style={{ fontFamily:MONO, fontSize:10, color:t.fg3 }}>
              {isAdmin ? 'admin@towson · v2.4' : 'maria.g@towson · line'}
            </div>
          </div>
          <RoleBadge role={role} t={t} />
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:8, background:t.panel2, border:`1px solid ${t.borderStrong}`, borderRadius:6, padding:'9px 12px' }}>
          <span style={{ fontFamily:MONO, fontSize:11, color:t.fg3 }}>⌘P</span>
          <span style={{ flex:1, fontFamily:MONO, fontSize:12, color:t.fg }}>salm<span style={{ color:t.accent, animation:'cmdblink2 1s steps(2) infinite' }}>▍</span></span>
          <span style={{ fontFamily:MONO, fontSize:9.5, color:t.fg3, padding:'1px 5px', border:`1px solid ${t.border}`, borderRadius:3 }}>esc</span>
        </div>
      </div>

      {/* Palette results */}
      <div style={{ background:t.accentBg, borderBottom:`1px solid ${t.border}`, padding:'10px 16px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
          <div style={{ fontFamily:MONO, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.6 }}>matches</div>
          {!isAdmin && (
            <span style={{ fontFamily:MONO, fontSize:8.5, color:t.fg3 }}>scope: items, recipes</span>
          )}
        </div>
        {matches.map(([type,n,sub,tone,meta],i,arr) => (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0', borderBottom: i<arr.length-1?`1px dashed ${t.border}`:'none' }}>
            <span style={{ fontFamily:MONO, fontSize:9.5, fontWeight:700, color:t.fg3, width:50, textTransform:'uppercase', letterSpacing:0.5 }}>{type}</span>
            <span style={{ fontWeight:500, fontSize:13, flex:1, color:t.fg }}>{n}</span>
            <span style={{ fontFamily:MONO, fontSize:10, color:tone }}>{meta}</span>
            <span style={{ fontFamily:MONO, fontSize:10, color:t.fg3, width:30, textAlign:'right' }}>{sub}</span>
          </div>
        ))}
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'8px 0 12px' }}>
        {tree.map(group => (
          <div key={group.name} style={{ marginTop:12 }}>
            <div style={{ padding:'4px 16px 6px', fontFamily:MONO, fontSize:9.5, fontWeight:600, color:t.fg3, textTransform:'uppercase', letterSpacing:0.6, display:'flex', alignItems:'center', gap:6 }}>
              <span>▾</span>{group.name}
            </div>
            {group.items.map(([label, kbd, sel]) => (
              <div key={label} style={{
                padding:'9px 16px 9px 32px', fontSize:14, display:'flex', alignItems:'center', gap:10,
                background: sel ? t.accentBg : 'transparent',
                color: sel ? t.fg : t.fg2,
                borderLeft: sel ? `3px solid ${t.accent}` : '3px solid transparent',
                fontWeight: sel ? 600 : 500,
              }}>
                <span style={{ flex:1 }}>{label}</span>
                <span style={{ fontFamily:MONO, fontSize:9.5, color:t.fg3, padding:'1px 5px', border:`1px solid ${t.border}`, borderRadius:3 }}>⌘{kbd}</span>
              </div>
            ))}
          </div>
        ))}

        {/* Show restricted-for-staff section greyed out */}
        {!isAdmin && (
          <div style={{ marginTop:18, opacity:0.42 }}>
            <div style={{ padding:'4px 16px 6px', fontFamily:MONO, fontSize:9.5, fontWeight:600, color:t.fg3, textTransform:'uppercase', letterSpacing:0.6, display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ width:10, textAlign:'center' }}>🔒</span>Admin-only
            </div>
            {restricted.map(label => (
              <div key={label} style={{
                padding:'9px 16px 9px 32px', fontSize:14, display:'flex', alignItems:'center', gap:10,
                color:t.fg3, borderLeft:'3px solid transparent',
              }}>
                <span style={{ flex:1, textDecoration:'line-through', textDecorationColor:t.fg3 }}>{label}</span>
                <span style={{ fontFamily:MONO, fontSize:9, color:t.fg3 }}>restricted</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ borderTop:`1px solid ${t.border}`, background:t.panel, padding:'10px 16px 28px', display:'flex', alignItems:'center', justifyContent:'space-between', fontFamily:MONO, fontSize:10.5, color:t.fg3, flexShrink:0 }}>
        <span>● {isAdmin?'admin@towson':'maria.g@towson'}</span>
        {isAdmin
          ? <span>EOD {KPIS.eodSubmitted}/{KPIS.eodTotal}</span>
          : <span style={{ color:t.accent }}>your shift · 18:42</span>}
      </div>
      <style>{`@keyframes cmdblink2{50%{opacity:0}}`}</style>
    </div>
  );
};

window.MobileCmdList = MobileCmdList;
window.MobileCmdDetail = MobileCmdDetail;
window.MobileCmdNav = MobileCmdNav;
