// Operations screens: Dashboard, EOD count, Waste log, Receiving.
// Inventory is in layout-command.jsx (already shipped).

const Caption = ({ t, children, right }) => (
  <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8 }}>
    <div style={{ fontFamily:window.cmdMono, fontSize:10, fontWeight:600, color:t.fg3, textTransform:'uppercase', letterSpacing:0.6 }}>{children}</div>
    {right && <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>{right}</div>}
  </div>
);

const Card = ({ t, children, style }) => (
  <div style={{ background:t.panel, border:`1px solid ${t.border}`, borderRadius:6, padding:14, ...style }}>{children}</div>
);

const StatTile = ({ t, label, value, sub, tone }) => (
  <Card t={t} style={{ padding:'12px 14px' }}>
    <div style={{ fontFamily:window.cmdMono, fontSize:9.5, fontWeight:600, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5, marginBottom:6 }}>{label}</div>
    <div style={{ fontFamily:window.cmdMono, fontSize:22, fontWeight:600, letterSpacing:-0.4, color: tone==='warn'?t.warn : tone==='danger'?t.danger : tone==='ok'?t.ok : t.fg, fontVariantNumeric:'tabular-nums' }}>{value}</div>
    <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3, marginTop:4 }}>{sub}</div>
  </Card>
);

const Pill = ({ t, status, children }) => {
  const fg = status==='ok'?t.ok : status==='low'||status==='warn'?t.warn : status==='out'||status==='danger'?t.danger : status==='info'?t.info : t.fg2;
  const bg = status==='ok'?t.okBg : status==='low'||status==='warn'?t.warnBg : status==='out'||status==='danger'?t.dangerBg : status==='info'?t.infoBg : t.panel2;
  return <span style={{ fontFamily:window.cmdMono, fontSize:9.5, fontWeight:700, padding:'2px 7px', borderRadius:3, letterSpacing:0.5, textTransform:'uppercase', color:fg, background:bg }}>{children}</span>;
};

// =================================================================
// 1. DASHBOARD — full-width, KPI grid + activity + alerts + chart
// =================================================================
const ScreenDashboard = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const { KPIS, RECENT_ACTIVITY, FOOD_COST_TREND, INVENTORY } = window.IM_DATA;
  const lows = INVENTORY.filter(i => i.status==='low' || i.status==='out');
  const max = Math.max(...FOOD_COST_TREND), min = Math.min(...FOOD_COST_TREND);
  const points = FOOD_COST_TREND.map((v,i) => {
    const x = 16 + (i / (FOOD_COST_TREND.length-1)) * 488;
    const y = 18 + (1 - (v - min) / (max - min || 1)) * 92;
    return [x, y];
  });
  const path = points.map((p,i)=> (i===0?'M':'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = path + ` L ${points[points.length-1][0].toFixed(1)},122 L ${points[0][0].toFixed(1)},122 Z`;

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg }}>
      {/* tab bar (informational, no list pane on Dashboard) */}
      <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
        {['overview.tsx','today.tsx'].map((x,i)=>(
          <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, fontWeight:500, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
        ))}
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>store: <span style={{color:t.fg}}>towson</span> · period: <span style={{color:t.fg}}>today</span></div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
        {/* hero row */}
        <div style={{ marginBottom:18 }}>
          <div style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3, marginBottom:4 }}>// good morning, admin · {new Date().toDateString().toLowerCase()}</div>
          <h1 style={{ margin:0, fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Towson · day in progress</h1>
        </div>

        {/* KPI grid 4-up */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginBottom:14 }}>
          <StatTile t={t} label="INVENTORY VALUE" value={`$${KPIS.inventoryValue.toLocaleString()}`} sub="142 items · 6 cats" />
          <StatTile t={t} label="FOOD COST %" value={`${KPIS.foodCostPct}%`} sub="↘ 0.6 vs target" tone="warn" />
          <StatTile t={t} label="WASTE / WK" value={`$${KPIS.wasteWeek}`} sub="↗ 12% vs last wk" tone="warn" />
          <StatTile t={t} label="OPEN POs" value={KPIS.openPOs} sub={`${KPIS.ordersDue} due today`} />
        </div>

        {/* alerts row + chart row */}
        <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:14, marginBottom:14 }}>
          <Card t={t}>
            <Caption t={t} right="14d">FOOD_COST_TREND.DAT</Caption>
            <svg width="100%" height="140" viewBox="0 0 520 140" style={{ display:'block' }}>
              {[0,1,2,3].map(i => (
                <line key={i} x1="16" y1={18 + i*30} x2="504" y2={18 + i*30} stroke={t.border} strokeDasharray="2 4" />
              ))}
              <line x1="16" y1={18 + (1 - (32 - min)/(max-min||1)) * 92} x2="504" y2={18 + (1 - (32 - min)/(max-min||1)) * 92} stroke={t.warn} strokeDasharray="3 3" />
              <path d={area} fill={t.accent} fillOpacity="0.15" />
              <path d={path} fill="none" stroke={t.accent} strokeWidth="2" />
              {points.map((p,i)=>(
                <circle key={i} cx={p[0]} cy={p[1]} r={i===points.length-1?3.5:1.8} fill={t.accent} />
              ))}
            </svg>
            <div style={{ display:'flex', gap:14, fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, marginTop:4 }}>
              <span><span style={{color:t.accent}}>■</span> daily %</span>
              <span><span style={{color:t.warn}}>—</span> target 32%</span>
              <span style={{ marginLeft:'auto', color:t.warn }}>↘ 31.4% today</span>
            </div>
          </Card>
          <Card t={t}>
            <Caption t={t} right={`${lows.length} ITEMS`}>STOCK_ALERTS</Caption>
            <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
              {lows.slice(0,5).map((i,idx) => (
                <div key={i.id} style={{ display:'flex', alignItems:'center', padding:'8px 0', borderTop: idx===0?'none':`1px dashed ${t.border}`, gap:10 }}>
                  <span style={{ width:6, height:6, borderRadius:99, background: i.status==='out'?t.danger:t.warn, flexShrink:0 }} />
                  <span style={{ flex:1, fontSize:12.5, fontWeight:600 }}>{i.name}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{i.stock}/{i.par} {i.unit}</span>
                  <Pill t={t} status={i.status}>{i.status}</Pill>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* activity full-width */}
        <Card t={t}>
          <Caption t={t} right="last 6 events">ACTIVITY_LOG</Caption>
          <div>
            {RECENT_ACTIVITY.map((a,i)=>(
              <div key={i} style={{ display:'flex', alignItems:'center', padding:'8px 0', borderTop: i===0?'none':`1px dashed ${t.border}`, gap:10 }}>
                <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3, width:38 }}>{a.ago}</span>
                <span style={{ width:18, height:18, borderRadius:99, background:t.accentBg, color:t.accent, fontFamily:window.cmdMono, fontSize:9, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>{a.who}</span>
                <span style={{ fontSize:12.5, color:t.fg }}><b style={{fontWeight:600}}>{a.name}</b> {a.action} <span style={{color:t.fg2}}>{a.target}</span></span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

// =================================================================
// 2. EOD COUNT — single-page worksheet, all items by vendor + category
// (modeled on the live IMR screenshot: search → category chips →
//  vendor tabs → grouped item rows with inline cases/each + notes)
// =================================================================
const EOD_COUNT_ITEMS = [
  // Cleaning Supplies — vendor: GOLDEN CITY (cutoff 22:00)
  { cat:'Cleaning Supplies', name:'Bleach',              pack:'1 case = 6 each',  expected:0,   units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Cleaning Supplies', name:'Toilet Paper Rolls',  pack:'no case info',     expected:0,   units:['cases'],         vendor:'GOLDEN CITY', warn:'No case info' },
  { cat:'Cleaning Supplies', name:'Hand Kraft Towels',   pack:'1 case = 12 each', expected:0,   units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Cleaning Supplies', name:'Floor Cleaner Fabuloso', pack:'no case info',  expected:0,   units:['each'],          vendor:'GOLDEN CITY', warn:'No case info' },
  { cat:'Cleaning Supplies', name:'Dish Detergent',      pack:'1 case = 4 each',  expected:0,   units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Cleaning Supplies', name:'Floor Cleaner Powder',pack:'no case info',     expected:0,   units:['bags'],          vendor:'GOLDEN CITY', warn:'No case info' },
  // Condiments
  { cat:'Condiments', name:'Cooking Wine',     pack:'1 case = 4 each',  expected:0,   units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Condiments', name:'Soy Sauce — Light',pack:'1 case = 6 jugs',  expected:1.0, units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Condiments', name:'Sesame Oil',       pack:'1 case = 12 each', expected:6.0, units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Condiments', name:'Oyster Sauce',     pack:'1 case = 6 each',  expected:2.0, units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Condiments', name:'Hoisin Sauce',     pack:'1 case = 6 each',  expected:0.5, units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Condiments', name:'Rice Vinegar',     pack:'1 case = 12 each', expected:8.0, units:['cases','each'], vendor:'GOLDEN CITY' },
  // Dairy & Sauce
  { cat:'Dairy & Sauce', name:'Heavy cream',   pack:'1 case = 4 qt',    expected:6.0, units:['cases','each'], vendor:'SYSCO' },
  // Dry goods
  { cat:'Dry goods', name:'AP flour',          pack:'1 bag = 50 lb',    expected:50,  units:['bags'],          vendor:'SYSCO' },
  // Protein
  { cat:'Protein', name:'Chicken thigh',       pack:'1 case = 40 lb',   expected:30,  units:['cases','lbs'],   vendor:'SYSCO' },
  { cat:'Protein', name:'Beef tenderloin',     pack:'1 case = 12 lb',   expected:18,  units:['cases','lbs'],   vendor:'SYSCO' },
  // Seafood
  { cat:'Seafood', name:'Atlantic salmon',     pack:'1 case = 8 lb',    expected:12,  units:['cases','lbs'],   vendor:'SYSCO' },
  // Vegetable & Produce — GOLDEN CITY
  { cat:'Vegetable & Produce', name:'Bok choy',     pack:'1 case = 25 lb', expected:8,  units:['cases','lbs'], vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Bean sprouts', pack:'1 bag = 5 lb',   expected:10, units:['bags'],         vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Scallions',    pack:'1 case = 24 ea', expected:24, units:['cases','each'], vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Garlic',       pack:'1 case = 10 lb', expected:6,  units:['cases','lbs'], vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Ginger',       pack:'1 case = 5 lb',  expected:3,  units:['cases','lbs'], vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Snow peas',    pack:'1 case = 10 lb', expected:4,  units:['cases','lbs'], vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Bell peppers', pack:'1 case = 25 lb', expected:5,  units:['cases','lbs'], vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Mushrooms',    pack:'1 case = 10 lb', expected:6,  units:['cases','lbs'], vendor:'GOLDEN CITY' },
  { cat:'Vegetable & Produce', name:'Carrots',      pack:'1 bag = 25 lb',  expected:25, units:['bags'],         vendor:'GOLDEN CITY' },
];

const EOD_VENDORS = [
  { name:'GOLDEN CITY (CHINESE DISTRIBUTOR)', cutoff:'22:00', count: EOD_COUNT_ITEMS.filter(x=>x.vendor==='GOLDEN CITY').length },
  { name:'SYSCO',                              cutoff:'16:00', count: EOD_COUNT_ITEMS.filter(x=>x.vendor==='SYSCO').length },
];

const EODField = ({ t, label, value, autofocus }) => (
  <div style={{ width:60, display:'flex', flexDirection:'column', alignItems:'center' }}>
    <input
      defaultValue={value === 0 ? '0' : String(value || '0')}
      style={{
        width:'100%', height:30, textAlign:'center',
        fontFamily:window.cmdMono, fontSize:13, fontWeight:600, fontVariantNumeric:'tabular-nums',
        color: autofocus ? t.fg : t.fg2,
        background: autofocus ? t.panel2 : t.panel, border:`1px solid ${autofocus ? t.accent : t.border}`, borderRadius:4, outline:'none',
      }}
    />
    <div style={{ fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, marginTop:3, textTransform:'lowercase' }}>{label}</div>
  </div>
);

const EODRow = ({ t, item, isFirst }) => (
  <div style={{
    display:'grid',
    gridTemplateColumns:'1fr auto auto auto',
    columnGap:14, rowGap:0, alignItems:'center',
    padding:'10px 0', borderTop: isFirst ? 'none' : `1px dashed ${t.border}`,
  }}>
    <div style={{ minWidth:0 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ fontSize:13.5, fontWeight:600, color:t.fg, letterSpacing:-0.1, whiteSpace:'nowrap' }}>{item.name}</div>
        {item.warn && (
          <span style={{
            fontFamily:window.cmdMono, fontSize:9.5, fontWeight:700, padding:'1.5px 6px',
            borderRadius:3, color:t.warn, background:t.warnBg, letterSpacing:0.3,
            whiteSpace:'nowrap', flexShrink:0,
          }}>⚠ {item.warn}</span>
        )}
      </div>
      <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, marginTop:2 }}>
        {item.pack}{item.expected > 0 ? ` · expected ${item.expected} ${item.units[item.units.length-1] === 'each' ? 'ea' : item.units[item.units.length-1]}` : ' · expected 0'}
      </div>
    </div>
    <div /> {/* gap col */}
    {/* unit inputs */}
    <div style={{ display:'flex', alignItems:'flex-start', gap:6 }}>
      {item.units.map((u, i) => (
        <React.Fragment key={u}>
          <EODField t={t} label={u} value={0} autofocus={i===0 && item.expected===0} />
          {i < item.units.length - 1 && (
            <div style={{ fontFamily:window.cmdMono, fontSize:14, color:t.fg3, marginTop:6 }}>+</div>
          )}
        </React.Fragment>
      ))}
    </div>
    <input
      placeholder="Note…"
      style={{
        width:280, height:30, padding:'0 10px',
        fontFamily:window.cmdMono, fontSize:11.5, color:t.fg2,
        background:t.panel, border:`1px solid ${t.border}`, borderRadius:4, outline:'none',
      }}
    />
  </div>
);

const ScreenEOD = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const cats = ['All (29)','Cleaning Supplies (6)','Condiments (8)','Dairy & Sauce (1)','Dry goods (1)','Protein (1)','Seafood (1)','Vegetable & Produce (9)'];
  const grouped = ['Cleaning Supplies','Condiments','Dairy & Sauce','Dry goods','Protein','Seafood','Vegetable & Produce'].map(c => ({
    cat: c, items: EOD_COUNT_ITEMS.filter(x => x.cat === c),
  })).filter(g => g.items.length);

  return (
    <>
      {/* Week sidebar — date-of-week list */}
      <div style={{ width:240, background:t.panel, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0 }}>
        <div style={{ padding:'14px 16px 10px', borderBottom:`1px solid ${t.border}` }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6 }}>
            <div style={{ fontSize:14, fontWeight:700, letterSpacing:-0.1 }}>This week</div>
            <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>wk 18</div>
          </div>
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3 }}>May 2 — May 8 · towson</div>
        </div>
        <div style={{ flex:1, overflow:'auto', padding:'4px 0' }}>
          {[
            { day:'Saturday',  date:'May 2',  status:'today',     counted:0,  total:26, vendors:'GOLDEN CITY · SYSCO' },
            { day:'Friday',    date:'May 1',  status:'submitted', counted:24, total:24, vendors:'SYSCO · LANCASTER'   },
            { day:'Thursday',  date:'Apr 30', status:'submitted', counted:18, total:18, vendors:'SAMUELS · US FOODS'  },
            { day:'Wednesday', date:'Apr 29', status:'submitted', counted:22, total:22, vendors:'TRICKLING SPRINGS'   },
            { day:'Tuesday',   date:'Apr 28', status:'late',      counted:19, total:21, vendors:'LANCASTER · SYSCO'   },
            { day:'Monday',    date:'Apr 27', status:'submitted', counted:24, total:24, vendors:'GOLDEN CITY · SYSCO' },
            { day:'Sunday',    date:'Apr 26', status:'rest',      counted:0,  total:0,  vendors:'no deliveries'      },
          ].map((d, i) => {
            const isToday = d.status === 'today';
            const isRest = d.status === 'rest';
            const dotColor = isToday ? t.accent : d.status==='submitted' ? t.ok : d.status==='late' ? t.warn : t.fg3;
            return (
              <div key={d.date} style={{
                padding:'10px 16px', borderBottom: i===6 ? 'none' : `1px solid ${t.border}`,
                background: isToday ? t.accentBg : 'transparent',
                borderLeft: isToday ? `2px solid ${t.accent}` : '2px solid transparent',
                opacity: isRest ? 0.5 : 1,
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ width:7, height:7, borderRadius:99, background:dotColor, flexShrink:0 }} />
                  <span style={{ flex:1, fontSize:13, fontWeight: isToday?700:600, color:t.fg }}>{d.day}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3, fontVariantNumeric:'tabular-nums' }}>{d.date}</span>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:5, paddingLeft:15 }}>
                  <span style={{
                    fontFamily:window.cmdMono, fontSize:9, fontWeight:700, padding:'1.5px 6px', borderRadius:3, letterSpacing:0.5, textTransform:'uppercase',
                    color: isToday?t.accent : d.status==='submitted'?t.ok : d.status==='late'?t.warn : t.fg3,
                    background: isToday?t.accentBg : d.status==='submitted'?t.okBg : d.status==='late'?t.warnBg : t.panel2,
                  }}>{d.status}</span>
                  {!isRest && (
                    <span style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>
                      {d.counted}/{d.total}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, marginTop:4, paddingLeft:15, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                  {d.vendors.toLowerCase()}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding:'8px 14px', borderTop:`1px solid ${t.border}`, display:'flex', alignItems:'center', justifyContent:'space-between', fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>
          <span>week total</span>
          <span style={{ color:t.fg }}>87/115</span>
        </div>
      </div>

      {/* Worksheet pane */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg, minWidth:0, position:'relative' }}>
      {/* tab bar (file-tab style) */}
      <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
        {['count.tsx','history.tsx','variance.log'].map((x,i)=>(
          <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
        ))}
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3 }}>Saturday, May 2 · 1:20 PM</div>
        <div style={{ width:1, height:16, background:t.border }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 9px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>SAVE DRAFT  ⌘S</div>
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>SUBMIT COUNT  ⌘⏎</div>
      </div>

      {/* sticky filter chrome */}
      <div style={{ background:t.panel, borderBottom:`1px solid ${t.border}`, padding:'12px 22px 0', flexShrink:0 }}>
        {/* search */}
        <div style={{ display:'flex', alignItems:'center', gap:8, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, padding:'7px 11px', marginBottom:10, whiteSpace:'nowrap' }}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke={t.fg3} strokeWidth="1.5"><circle cx="5.5" cy="5.5" r="4"/><path d="M9 9l3 3"/></svg>
          <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg3 }}>Search items…</span>
          <span style={{ flex:1 }} />
          <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3, padding:'2px 6px', border:`1px solid ${t.border}`, borderRadius:3 }}>⌘K</span>
        </div>
        {/* vendor tabs — ABOVE category chips */}
        <div style={{ display:'flex', gap:6, marginBottom:8, whiteSpace:'nowrap' }}>
          {EOD_VENDORS.map((v, i) => (
            <div key={v.name} style={{
              fontFamily:window.cmdMono, fontSize:11, fontWeight: i===0?700:500,
              padding:'6px 12px', borderRadius:5, whiteSpace:'nowrap',
              border:`1px solid ${i===0 ? t.fg : t.border}`,
              background: i===0 ? t.fg : t.panel,
              color: i===0 ? t.bg : t.fg2,
              display:'inline-flex', alignItems:'center', gap:8,
            }}>
              <span>{v.name} ({v.count})</span>
              <span style={{ opacity:0.6 }}>·</span>
              <span>cutoff {v.cutoff}</span>
            </div>
          ))}
        </div>
        {/* category chips — below vendors */}
        <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
          {cats.map((c,i) => (
            <div key={c} style={{
              fontFamily:window.cmdMono, fontSize:11, fontWeight: i===0?700:500,
              padding:'5px 11px', borderRadius:99, whiteSpace:'nowrap',
              border:`1px solid ${i===0 ? t.accent : t.border}`,
              background: i===0 ? t.accentBg : t.panel,
              color: i===0 ? t.accent : t.fg2,
            }}>{c}</div>
          ))}
        </div>
        {/* status line */}
        <div style={{
          fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3,
          padding:'6px 0 10px', display:'flex', alignItems:'center', gap:10, whiteSpace:'nowrap',
        }}>
          <span style={{ color:t.warn }}>●</span>
          <span>0 of 26 items counted</span>
          <span>·</span>
          <span style={{ color:t.fg2 }}>vendor: GOLDEN CITY</span>
          <span style={{ flex:1 }} />
          <span>counter: <span style={{ color:t.fg }}>maria.g</span></span>
        </div>
      </div>

      {/* item list — grouped by category */}
      <div style={{ flex:1, overflow:'auto', padding:'4px 22px 100px' }}>
        {/* column header strip */}
        <div style={{
          display:'grid', gridTemplateColumns:'1fr auto auto auto', columnGap:14,
          padding:'10px 0 6px', borderBottom:`1px dashed ${t.border}`,
          fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, fontWeight:600,
          letterSpacing:0.5, textTransform:'uppercase',
        }}>
          <span>item · pack</span>
          <span />
          <span style={{ width:194, textAlign:'center' }}>count</span>
          <span style={{ width:280 }}>note</span>
        </div>
        {grouped.map((g, gi) => (
          <div key={g.cat} style={{ marginTop: gi===0 ? 14 : 22 }}>
            <div style={{
              fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700,
              color:t.fg3, textTransform:'uppercase', letterSpacing:0.7,
              marginBottom:4,
              display:'flex', alignItems:'baseline', gap:10,
            }}>
              <span>// {g.cat.toLowerCase()}</span>
              <span style={{ flex:1, height:1, background:t.border, alignSelf:'center', marginTop:2 }} />
              <span style={{ color:t.fg3, fontWeight:500 }}>{g.items.length} items</span>
            </div>
            {g.items.map((it, i) => <EODRow key={it.name} t={t} item={it} isFirst={i===0} />)}
          </div>
        ))}
      </div>

      {/* sticky footer summary */}
      <div style={{
        position:'absolute', left:0, right:0, bottom:0,
        background:t.panel, borderTop:`1px solid ${t.border}`,
        padding:'10px 22px', display:'flex', alignItems:'center', gap:14,
        fontFamily:window.cmdMono, fontSize:11, color:t.fg2,
      }}>
        <span style={{ color:t.warn }}>0/26 counted</span>
        <span>·</span>
        <span>est. value <span style={{ color:t.fg, fontWeight:600 }}>$0.00</span></span>
        <span>·</span>
        <span>variance <span style={{ color:t.fg }}>—</span></span>
        <span style={{ flex:1 }} />
        <span style={{ color:t.fg3 }}>tab moves cell · ⏎ next item · ⌘S save · ⌘⏎ submit</span>
      </div>
      </div>
    </>
  );
};

// =================================================================
// 3. WASTE LOG — list pane (recent) + detail (form to log)
// =================================================================
const ScreenWaste = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const events = [
    { id:'w-2104', when:'12m', who:'JT', name:'Atlantic salmon',  qty:1.2, unit:'lb', cost:17.04, reason:'spoilage',     cat:'Seafood' },
    { id:'w-2103', when:'2h',  who:'MG', name:'Heirloom tomato',  qty:3.4, unit:'lb', cost:10.54, reason:'overproduction',cat:'Produce' },
    { id:'w-2102', when:'5h',  who:'JT', name:'Heavy cream',      qty:0.8, unit:'qt', cost: 3.52, reason:'expired',      cat:'Dairy'   },
    { id:'w-2101', when:'1d',  who:'AR', name:'Romaine hearts',   qty:6.0, unit:'ea', cost:10.80, reason:'wilted',       cat:'Produce' },
    { id:'w-2100', when:'1d',  who:'MG', name:'Brioche buns',     qty:8.0, unit:'ea', cost: 4.40, reason:'stale',        cat:'Bakery'  },
    { id:'w-2099', when:'2d',  who:'JT', name:'Maine lobster',    qty:0.6, unit:'lb', cost:16.80, reason:'damaged',      cat:'Seafood' },
    { id:'w-2098', when:'2d',  who:'JT', name:'Atlantic salmon',  qty:0.4, unit:'lb', cost: 5.68, reason:'overproduction',cat:'Seafood' },
    { id:'w-2097', when:'3d',  who:'MG', name:'Smoked paprika',   qty:0.1, unit:'lb', cost: 1.80, reason:'spilled',      cat:'Spices'  },
  ];
  const sel = events[0];

  return (
    <>
      <div style={{ width:340, background:t.panel, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0 }}>
        <div style={{ padding:'14px 16px 10px', borderBottom:`1px solid ${t.border}` }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6 }}>
            <div style={{ fontSize:14, fontWeight:700, letterSpacing:-0.1 }}>Waste log</div>
            <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>$412 wk</div>
          </div>
          <div style={{ marginTop:8, display:'flex', alignItems:'center', gap:6, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, padding:'5px 9px' }}>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>filter:</span>
            <span style={{ flex:1, fontFamily:window.cmdMono, fontSize:11, color:t.fg }}>last:7d</span>
          </div>
          <div style={{ display:'flex', gap:6, marginTop:8, overflowX:'auto' }}>
            {[['all',24],['spoilage',8],['overprod',6],['expired',5],['damaged',3]].map(([k,n],i) => (
              <span key={k} style={{
                padding:'4px 9px', fontFamily:window.cmdMono, fontSize:10.5, fontWeight:600, borderRadius:99,
                background: i===0?t.accentBg:t.panel2, border:`1px solid ${i===0?t.accent:t.border}`,
                color: i===0?t.fg:t.fg2, whiteSpace:'nowrap'
              }}>{k} <span style={{ color:t.fg3 }}>{n}</span></span>
            ))}
          </div>
        </div>
        <div style={{ flex:1, overflow:'auto' }}>
          {events.map((e,i) => {
            const isSel = e.id === sel.id;
            return (
              <div key={e.id} style={{
                padding:'10px 16px', borderBottom:`1px solid ${t.border}`,
                background: isSel ? t.accentBg : 'transparent',
                borderLeft: isSel ? `2px solid ${t.accent}` : '2px solid transparent',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3, width:32 }}>{e.when}</span>
                  <span style={{ flex:1, fontSize:13, fontWeight:600 }}>{e.name}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.warn, fontVariantNumeric:'tabular-nums' }}>−${e.cost.toFixed(2)}</span>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:4, paddingLeft:40 }}>
                  <span style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{e.qty} {e.unit}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>· {e.reason}</span>
                  <span style={{ flex:1 }} />
                  <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>{e.who}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg, minWidth:0 }}>
        <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
          {['log.tsx','recent.tsx','report.tsx'].map((x,i)=>(
            <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
          ))}
          <div style={{ flex:1 }} />
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>+ LOG WASTE  ⌘W</div>
        </div>
        <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
          <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Log new waste</h1>
          <div style={{ fontSize:13, color:t.fg2, marginBottom:18 }}>Records cost & reduces on-hand stock. Required nightly per BOH SOP.</div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
            <Card t={t}>
              <Caption t={t}>ITEM</Caption>
              <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:t.panel2, border:`1px solid ${t.borderStrong}`, borderRadius:5 }}>
                <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>i03</span>
                <span style={{ fontSize:13, fontWeight:600 }}>Atlantic salmon</span>
                <span style={{ flex:1 }} />
                <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.accent }}>change ⌘I</span>
              </div>
              <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, marginTop:8 }}>on-hand 4.2 lb · cost $14.20/lb</div>
            </Card>
            <Card t={t}>
              <Caption t={t}>QUANTITY</Caption>
              <div style={{ display:'flex', alignItems:'baseline', gap:6 }}>
                <input defaultValue="1.2" readOnly style={{ flex:1, fontFamily:window.cmdMono, fontSize:28, fontWeight:600, color:t.fg, background:'transparent', border:'none', outline:'none', width:'100%' }} />
                <span style={{ fontFamily:window.cmdMono, fontSize:14, color:t.fg3 }}>lb</span>
              </div>
              <div style={{ height:1, background:t.accent, marginTop:6 }} />
              <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.warn, marginTop:8 }}>= −$17.04 cost · 28% of on-hand</div>
            </Card>
          </div>

          <Card t={t} style={{ marginBottom:14 }}>
            <Caption t={t}>REASON</Caption>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              {['spoilage','overproduction','expired','damaged','wilted','wrong order','spilled','other'].map((r,i)=>(
                <span key={r} style={{
                  padding:'6px 12px', fontFamily:window.cmdMono, fontSize:11.5, fontWeight:600, borderRadius:5,
                  background: i===0?t.accentBg:t.panel2, border:`1px solid ${i===0?t.accent:t.border}`,
                  color: i===0?t.fg:t.fg2,
                }}>{r}</span>
              ))}
            </div>
          </Card>

          <Card t={t}>
            <Caption t={t} right="optional">NOTE</Caption>
            <div style={{ fontFamily:window.cmdMono, fontSize:12, color:t.fg2, padding:'8px 10px', background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, minHeight:60 }}>
              found at start of service · likely from yesterday's portioning · flagging Samuels QC<span style={{ color:t.accent }}>▍</span>
            </div>
            <div style={{ display:'flex', gap:10, marginTop:10, fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3 }}>
              <span>📎 attach photo</span>
              <span style={{ marginLeft:'auto' }}>⏎ submit · esc cancel</span>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
};

// =================================================================
// 4. RECEIVING — list pane (POs in transit) + detail (line-items checklist)
// =================================================================
const ScreenReceiving = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const incoming = [
    { id:'PO-4821', vendor:'Sysco',         eta:'arrived',    items:12, total: 842.40, status:'receiving' },
    { id:'PO-4820', vendor:'Lancaster',     eta:'in transit', items: 8, total: 318.20, status:'transit'   },
    { id:'PO-4819', vendor:'Samuels',       eta:'in transit', items: 4, total: 612.00, status:'transit'   },
    { id:'PO-4822', vendor:'US Foods',      eta:'tomorrow',   items:18, total:1240.80, status:'sent'      },
    { id:'PO-4823', vendor:'H&S Bakery',    eta:'tomorrow',   items: 3, total:  96.00, status:'sent'      },
  ];
  const lineItems = [
    { id:'i01', name:'Beef tenderloin',  ordered:'8 lb',  received:'8 lb',  cost:'$179.20', state:'ok' },
    { id:'i02', name:'Chicken thigh',    ordered:'20 lb', received:'20 lb', cost:'$96.00',  state:'ok' },
    { id:'i08', name:'AP flour',         ordered:'50 lb', received:'50 lb', cost:'$31.00',  state:'ok' },
    { id:'i09', name:'Olive oil EV',     ordered:'4 gal', received:'3 gal', cost:'$152.00', state:'short' },
    { id:'i11', name:'Smoked paprika',   ordered:'2 lb',  received:'2 lb',  cost:'$36.00',  state:'ok' },
    { id:'i07', name:'Unsalted butter',  ordered:'10 lb', received:'',      cost:'$39.00',  state:'pending' },
    { id:'i06', name:'Heavy cream',      ordered:'8 qt',  received:'',      cost:'$35.20',  state:'pending' },
  ];

  return (
    <>
      <div style={{ width:300, background:t.panel, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0 }}>
        <div style={{ padding:'14px 16px 10px', borderBottom:`1px solid ${t.border}` }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between' }}>
            <div style={{ fontSize:14, fontWeight:700, letterSpacing:-0.1 }}>Receiving</div>
            <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>5 in flight</div>
          </div>
        </div>
        <div style={{ flex:1, overflow:'auto' }}>
          {incoming.map((po,i) => {
            const isSel = i===0;
            const tone = po.status==='receiving' ? 'warn' : po.status==='transit' ? 'info' : 'ok';
            return (
              <div key={po.id} style={{
                padding:'12px 16px', borderBottom:`1px solid ${t.border}`,
                background: isSel ? t.accentBg : 'transparent',
                borderLeft: isSel ? `2px solid ${t.accent}` : '2px solid transparent',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, fontWeight:600 }}>{po.id}</span>
                  <Pill t={t} status={tone}>{po.eta}</Pill>
                </div>
                <div style={{ fontSize:12.5, fontWeight:600 }}>{po.vendor}</div>
                <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, marginTop:3, fontVariantNumeric:'tabular-nums' }}>{po.items} items · ${po.total.toFixed(2)}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg, minWidth:0 }}>
        <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
          {['lines.tsx','docs.tsx','flag.tsx'].map((x,i)=>(
            <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
          ))}
          <div style={{ flex:1 }} />
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>SCAN BARCODE</div>
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>FINISH RECEIVING  ⏎</div>
        </div>
        <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>PO-4821</span>
            <Pill t={t} status="warn">receiving</Pill>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>· arrived 14:08 · driver Carlos</span>
          </div>
          <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Sysco · 12 lines</h1>
          <div style={{ fontSize:13, color:t.fg2, marginBottom:18 }}>Match each line to invoice. Short or damaged → flag for credit.</div>

          {/* Progress strip */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
            <StatTile t={t} label="LINES MATCHED" value="5 / 12" sub="42% complete" />
            <StatTile t={t} label="SHORTS" value="1" sub="−1 gal olive oil" tone="warn" />
            <StatTile t={t} label="DAMAGED" value="0" sub="—" />
            <StatTile t={t} label="INVOICE TOTAL" value="$842.40" sub="actual $828.40" />
          </div>

          <Caption t={t} right="press space to mark received">LINE_ITEMS.TSV</Caption>
          <Card t={t} style={{ padding:0 }}>
            <div style={{ display:'grid', gridTemplateColumns:'24px 60px 1fr 90px 90px 90px 80px', padding:'8px 14px', borderBottom:`1px solid ${t.border}`, fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5 }}>
              <span></span><span>id</span><span>name</span><span>ordered</span><span>received</span><span>line $</span><span style={{textAlign:'right'}}>state</span>
            </div>
            {lineItems.map((li,i) => {
              const tone = li.state==='ok'?t.ok : li.state==='short'?t.warn : t.fg3;
              return (
                <div key={li.id} style={{ display:'grid', gridTemplateColumns:'24px 60px 1fr 90px 90px 90px 80px', alignItems:'center', padding:'10px 14px', borderTop: i===0?'none':`1px solid ${t.border}`, background: li.state==='short' ? t.warnBg : 'transparent' }}>
                  <span style={{ width:14, height:14, borderRadius:3, border:`1px solid ${li.received?t.accent:t.borderStrong}`, background:li.received?t.accent:'transparent', display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, color:'#000', fontWeight:700 }}>{li.received?'✓':''}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{li.id}</span>
                  <span style={{ fontSize:13, fontWeight:600 }}>{li.name}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{li.ordered}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color: li.state==='short'?t.warn : t.fg, fontVariantNumeric:'tabular-nums' }}>{li.received || <span style={{color:t.fg3}}>—</span>}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg, fontVariantNumeric:'tabular-nums' }}>{li.cost}</span>
                  <span style={{ textAlign:'right' }}><Pill t={t} status={li.state==='ok'?'ok':li.state==='short'?'warn':'info'}>{li.state}</Pill></span>
                </div>
              );
            })}
          </Card>
        </div>
      </div>
    </>
  );
};

window.ScreenDashboard = ScreenDashboard;
window.ScreenEOD = ScreenEOD;
window.ScreenWaste = ScreenWaste;
window.ScreenReceiving = ScreenReceiving;
window.cmdScreensShared = { Card, Caption, StatTile, Pill };
