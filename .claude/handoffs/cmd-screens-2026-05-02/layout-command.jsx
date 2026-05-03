// Layout C — "Command": IDE-flavored, sidebar tree + main + right rail.
// Keyboard-first feel; built for ops + warehouse pros.

const CommandLayout = ({ dark }) => {
  const { INVENTORY, KPIS, RECENT_ACTIVITY, PURCHASE_ORDERS, VENDORS, CATEGORY_MIX, FOOD_COST_TREND } = window.IM_DATA;
  const [selected, setSelected] = React.useState('i03');
  const [section, setSection] = React.useState('Inventory');

  const t = dark ? {
    bg:'#08090C', sidebar:'#0E1014', panel:'#12141A', panel2:'#181B22', border:'rgba(255,255,255,0.06)', borderStrong:'rgba(255,255,255,0.12)',
    fg:'#E6E8EC', fg2:'#9BA0AB', fg3:'#5C6270',
    accent:'oklch(0.78 0.16 145)', accentBg:'oklch(0.30 0.08 145 / 0.4)',
    ok:'#5CB832', warn:'#E0A030', danger:'#E04848', info:'#5AA8F0',
    okBg:'rgba(92,184,50,0.15)', warnBg:'rgba(224,160,48,0.15)', dangerBg:'rgba(224,72,72,0.15)',
  } : {
    bg:'#FAFAF8', sidebar:'#FFFFFF', panel:'#FFFFFF', panel2:'#F4F4F0', border:'rgba(20,20,20,0.07)', borderStrong:'rgba(20,20,20,0.14)',
    fg:'#0E1014', fg2:'#5A5F68', fg3:'#9094A0',
    accent:'oklch(0.50 0.16 145)', accentBg:'oklch(0.93 0.06 145 / 1)',
    ok:'#3B6D11', warn:'#854F0B', danger:'#791F1F', info:'#185FA5',
    okBg:'#EAF3DE', warnBg:'#FAEEDA', dangerBg:'#FCEBEB',
  };

  const sans = '"Inter Tight", "Inter", system-ui, sans-serif';
  const mono = '"JetBrains Mono", "SF Mono", ui-monospace, monospace';

  const item = INVENTORY.find(i => i.id === selected) || INVENTORY[0];

  // Tree
  const tree = [
    { name:'Operations', children:['Dashboard','Inventory','EOD count','Waste log','Receiving'] },
    { name:'Planning', children:['Purchase orders','Vendors','Recipes','Restock'] },
    { name:'Insights', children:['Reconciliation','POS imports','Audit log','Reports'] },
  ];

  return (
    <div style={{ width:'100%', height:'100%', background:t.bg, color:t.fg, fontFamily:sans, fontSize:13, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      {/* Title bar */}
      <div style={{ height:32, background:t.sidebar, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 12px', gap:12, flexShrink:0 }}>
        <div style={{ display:'flex', gap:6 }}>
          <span style={{ width:11, height:11, borderRadius:99, background:'#FF5F57' }} />
          <span style={{ width:11, height:11, borderRadius:99, background:'#FEBC2E' }} />
          <span style={{ width:11, height:11, borderRadius:99, background:'#28C840' }} />
        </div>
        <div style={{ flex:1, display:'flex', justifyContent:'center', fontFamily:mono, fontSize:11, color:t.fg3 }}>
          inv://towson — {section.toLowerCase()} — {item.name.toLowerCase().replace(/\s+/g,'-')}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', fontFamily:mono, fontSize:10, color:t.fg3 }}>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:6, height:6, borderRadius:99, background:t.ok }} /> connected</span>
        </div>
      </div>

      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
        {/* Sidebar — tree */}
        <div style={{ width:240, background:t.sidebar, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'12px 14px 8px', display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:22, height:22, borderRadius:5, background:t.accent, color:'#000', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:mono, fontSize:12, fontWeight:700 }}>i</div>
            <div style={{ fontWeight:600, fontSize:13 }}>im.cmd</div>
            <div style={{ flex:1 }} />
            <div style={{ fontFamily:mono, fontSize:9.5, color:t.fg3, padding:'2px 6px', border:`1px solid ${t.border}`, borderRadius:3 }}>v2.4</div>
          </div>
          <div style={{ padding:'6px 10px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, padding:'5px 9px' }}>
              <span style={{ fontFamily:mono, fontSize:10, color:t.fg3 }}>⌘P</span>
              <span style={{ fontSize:11, color:t.fg3 }}>Go to anything…</span>
            </div>
          </div>
          <div style={{ flex:1, overflow:'auto', padding:'4px 0 12px' }}>
            {tree.map(group => (
              <div key={group.name} style={{ marginTop:8 }}>
                <div style={{ padding:'4px 14px', fontFamily:mono, fontSize:9.5, fontWeight:600, color:t.fg3, textTransform:'uppercase', letterSpacing:0.6, display:'flex', alignItems:'center', gap:5 }}>
                  <span>▾</span>{group.name}
                </div>
                {group.children.map(c => (
                  <div key={c} onClick={()=>setSection(c)} style={{
                    padding:'4px 14px 4px 26px', cursor:'pointer', fontSize:12.5,
                    background: section===c ? t.accentBg : 'transparent',
                    color: section===c ? t.fg : t.fg2,
                    borderLeft: section===c ? `2px solid ${t.accent}` : '2px solid transparent',
                  }}>{c}</div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ borderTop:`1px solid ${t.border}`, padding:'8px 14px', fontFamily:mono, fontSize:10, color:t.fg3, display:'flex', justifyContent:'space-between' }}>
            <span>● admin</span><span>{KPIS.eodSubmitted}/{KPIS.eodTotal}</span>
          </div>
        </div>

        {/* Mid — list */}
        <div style={{ width:340, borderRight:`1px solid ${t.border}`, background:t.panel, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'14px 16px 10px', borderBottom:`1px solid ${t.border}` }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
              <div style={{ fontWeight:700, fontSize:14, letterSpacing:-0.1 }}>{section}</div>
              <span style={{ fontFamily:mono, fontSize:10, color:t.fg3 }}>{INVENTORY.length} items</span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:6, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, padding:'5px 9px' }}>
              <span style={{ fontFamily:mono, fontSize:11, color:t.fg3 }}>filter:</span>
              <input placeholder="status:low cat:produce" style={{ flex:1, border:0, outline:0, background:'transparent', color:t.fg, fontFamily:mono, fontSize:11 }} />
            </div>
          </div>
          <div style={{ flex:1, overflow:'auto' }}>
            {INVENTORY.map(it => {
              const sel = it.id === selected;
              const tone = it.status==='out'?t.danger:it.status==='low'?t.warn:t.ok;
              const ratio = it.par > 0 ? Math.min(it.stock/it.par, 1) : 0;
              return (
                <div key={it.id} onClick={()=>setSelected(it.id)} style={{
                  padding:'10px 16px', cursor:'pointer', borderBottom:`1px solid ${t.border}`,
                  background: sel ? t.accentBg : 'transparent',
                  borderLeft: sel ? `2px solid ${t.accent}` : '2px solid transparent',
                }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5 }}>
                    <span style={{ width:6, height:6, borderRadius:99, background:tone }} />
                    <span style={{ fontWeight:600, fontSize:13, flex:1 }}>{it.name}</span>
                    <span style={{ fontFamily:mono, fontSize:10, color:t.fg3 }}>{it.id}</span>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:11, color:t.fg2 }}>
                    <span style={{ fontFamily:mono, fontVariantNumeric:'tabular-nums' }}>{it.stock.toFixed(1)}/{it.par} {it.unit}</span>
                    <div style={{ flex:1, height:3, background:t.panel2, borderRadius:99, overflow:'hidden' }}>
                      <div style={{ width:`${ratio*100}%`, height:'100%', background:tone }} />
                    </div>
                    <span style={{ color:t.fg3, fontSize:10 }}>{it.cat}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Main — detail + insights */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg }}>
          {/* Tabs */}
          <div style={{ height:36, borderBottom:`1px solid ${t.border}`, background:t.panel, display:'flex', alignItems:'flex-end', padding:'0 14px', gap:0 }}>
            {['Detail','Usage','Audit','Recipes'].map((x,i) => (
              <div key={x} style={{
                padding:'8px 14px', fontSize:12, fontWeight:500, cursor:'pointer',
                color: i===0 ? t.fg : t.fg2,
                borderBottom: i===0 ? `2px solid ${t.accent}` : '2px solid transparent',
                fontFamily:mono,
              }}>{x.toLowerCase()}.tsx</div>
            ))}
            <div style={{ flex:1 }} />
            <div style={{ alignSelf:'center', display:'flex', gap:6 }}>
              <button style={{ background:'transparent', color:t.fg2, border:`1px solid ${t.border}`, borderRadius:4, padding:'4px 10px', fontFamily:mono, fontSize:10.5, cursor:'pointer' }}>EDIT</button>
              <button style={{ background:t.accent, color:'#000', border:0, borderRadius:4, padding:'4px 10px', fontFamily:mono, fontSize:10.5, fontWeight:700, cursor:'pointer' }}>+ COUNT</button>
            </div>
          </div>

          <div style={{ flex:1, overflow:'auto', padding:'18px 22px' }}>
            {/* Hero */}
            <div style={{ display:'flex', alignItems:'flex-start', gap:14, marginBottom:18 }}>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                  <span style={{ fontFamily:mono, fontSize:11, color:t.fg3 }}>{item.id}</span>
                  <span style={{ fontFamily:mono, fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:3, color: item.status==='out'?t.danger:item.status==='low'?t.warn:t.ok, background: item.status==='out'?t.dangerBg:item.status==='low'?t.warnBg:t.okBg, textTransform:'uppercase', letterSpacing:0.5 }}>{item.status}</span>
                </div>
                <h1 style={{ margin:0, fontSize:26, fontWeight:700, letterSpacing:-0.4 }}>{item.name}</h1>
                <div style={{ fontSize:13, color:t.fg2, marginTop:4 }}>{item.cat} · supplied by {item.vendor} · last counted {item.updated} ago</div>
              </div>
            </div>

            {/* Stat grid */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginBottom:18 }}>
              {[
                ['On hand',  `${item.stock.toFixed(1)} ${item.unit}`, `par ${item.par}`],
                ['Cost / unit', `$${item.cost.toFixed(2)}`,            'avg L7d'],
                ['Stock value', `$${(item.stock*item.cost).toFixed(0)}`, 'at current cost'],
                ['Days of cover', `${(item.stock/2.4).toFixed(1)}d`, 'at avg usage'],
              ].map(([l,v,s],i) => (
                <div key={i} style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:'12px 14px' }}>
                  <div style={{ fontFamily:mono, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5, marginBottom:5 }}>{l}</div>
                  <div style={{ fontFamily:mono, fontSize:20, fontWeight:600, fontVariantNumeric:'tabular-nums' }}>{v}</div>
                  <div style={{ fontFamily:mono, fontSize:10, color:t.fg3, marginTop:3 }}>{s}</div>
                </div>
              ))}
            </div>

            {/* Two col */}
            <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:14 }}>
              {/* Stock chart */}
              <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:14 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                  <div style={{ fontFamily:mono, fontSize:10.5, fontWeight:600, color:t.fg2, textTransform:'uppercase', letterSpacing:0.6 }}>stock_history.dat — 14d</div>
                  <div style={{ fontFamily:mono, fontSize:10, color:t.fg3 }}>par={item.par} · safety=4</div>
                </div>
                {(() => {
                  const data = [16,15,14,16,18,17,15,13,11,10,9,7,6, item.stock];
                  const w=520, h=140, max=Math.max(...data, item.par+2);
                  const pts = data.map((v,i) => `${(i/(data.length-1))*w},${h - (v/max)*h}`);
                  return (
                    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
                      {[0,0.25,0.5,0.75,1].map((g,i) => <line key={i} x1="0" x2={w} y1={g*h} y2={g*h} stroke={t.border} strokeDasharray="2 4" />)}
                      <line x1="0" x2={w} y1={h-(item.par/max)*h} y2={h-(item.par/max)*h} stroke={t.warn} strokeDasharray="3 3" strokeWidth="1" />
                      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={t.accent} fillOpacity="0.15" />
                      <polyline points={pts.join(' ')} fill="none" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      {pts.map((p,i) => { const [x,y]=p.split(','); return <circle key={i} cx={x} cy={y} r={i===pts.length-1?3.5:1.8} fill={t.accent} />; })}
                    </svg>
                  );
                })()}
                <div style={{ display:'flex', gap:18, marginTop:10, fontFamily:mono, fontSize:10.5, color:t.fg3 }}>
                  <span><span style={{display:'inline-block', width:8, height:2, background:t.accent, marginRight:5}}/>on-hand</span>
                  <span><span style={{display:'inline-block', width:8, height:1, background:t.warn, marginRight:5}}/>par level</span>
                  <span style={{ marginLeft:'auto' }}>↘ 62% in 14d</span>
                </div>
              </div>

              {/* Properties */}
              <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:14 }}>
                <div style={{ fontFamily:mono, fontSize:10.5, fontWeight:600, color:t.fg2, textTransform:'uppercase', letterSpacing:0.6, marginBottom:10 }}>properties.json</div>
                <div style={{ fontFamily:mono, fontSize:11.5, lineHeight:1.7 }}>
                  {[
                    ['category', `"${item.cat}"`],
                    ['unit', `"${item.unit}"`],
                    ['vendor', `"${item.vendor}"`],
                    ['cost_per_unit', `$${item.cost.toFixed(2)}`],
                    ['par_level', item.par],
                    ['avg_daily_usage', '2.4'],
                    ['safety_stock', '4.0'],
                    ['lead_time_days', '2'],
                    ['last_counted', `"${item.updated} ago"`],
                  ].map(([k,v],i) => (
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'2px 0', borderBottom: i<8?`1px dashed ${t.border}`:'none' }}>
                      <span style={{ color:t.fg3 }}>{k}</span>
                      <span style={{ color:t.fg, fontVariantNumeric:'tabular-nums' }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Recipes & activity row */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginTop:14 }}>
              <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:14 }}>
                <div style={{ fontFamily:mono, fontSize:10.5, fontWeight:600, color:t.fg2, textTransform:'uppercase', letterSpacing:0.6, marginBottom:10 }}>used in 4 recipes</div>
                {[
                  ['Filet 8oz', '8 oz / serving', 142],
                  ['Steak frites', '6 oz / serving', 38],
                  ['Surf & turf', '6 oz / serving', 12],
                  ['Beef tartare', '4 oz / serving',  9],
                ].map(([n,q,sold],i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 0', borderBottom: i<3?`1px solid ${t.border}`:'none', fontSize:12.5 }}>
                    <span style={{ fontWeight:500, flex:1 }}>{n}</span>
                    <span style={{ fontFamily:mono, fontSize:11, color:t.fg2 }}>{q}</span>
                    <span style={{ fontFamily:mono, fontSize:11, color:t.fg, fontVariantNumeric:'tabular-nums', width:60, textAlign:'right' }}>{sold} sold/wk</span>
                  </div>
                ))}
              </div>
              <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:14 }}>
                <div style={{ fontFamily:mono, fontSize:10.5, fontWeight:600, color:t.fg2, textTransform:'uppercase', letterSpacing:0.6, marginBottom:10 }}>activity_log</div>
                {RECENT_ACTIVITY.slice(0,4).map((a,i) => (
                  <div key={i} style={{ display:'flex', gap:10, alignItems:'center', padding:'6px 0', borderBottom: i<3?`1px solid ${t.border}`:'none', fontSize:12 }}>
                    <span style={{ fontFamily:mono, fontSize:10, color:t.fg3, width:32 }}>{a.ago}</span>
                    <span style={{ width:18, height:18, borderRadius:99, background:t.accentBg, color:t.accent, fontFamily:mono, fontSize:9, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>{a.who}</span>
                    <span style={{ color:t.fg2, flex:1 }}><span style={{color:t.fg, fontWeight:500}}>{a.name}</span> {a.action}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Status bar */}
          <div style={{ height:24, borderTop:`1px solid ${t.border}`, background:t.panel, display:'flex', alignItems:'center', padding:'0 14px', gap:14, fontFamily:mono, fontSize:10, color:t.fg3, flexShrink:0 }}>
            <span>● synced</span>
            <span>row 3 / 142</span>
            <span>cat:{item.cat.toLowerCase()}</span>
            <span style={{ flex:1 }} />
            <span>UTF-8</span>
            <span>LF</span>
            <span style={{ color:t.accent }}>⌘K palette</span>
          </div>
        </div>
      </div>
    </div>
  );
};

window.CommandLayout = CommandLayout;
