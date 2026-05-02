// Planning screens: Purchase orders, Vendors, Recipes, Restock.

const { Card, Caption, StatTile, Pill } = window.cmdScreensShared;

// =================================================================
// 5. PURCHASE ORDERS — list pane (POs) + detail (PO with line items)
// =================================================================
const ScreenPOs = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const { PURCHASE_ORDERS } = window.IM_DATA;
  const sel = PURCHASE_ORDERS[1]; // Lancaster sent
  const lines = [
    { id:'i04', name:'Heirloom tomato',  qty:'12 lb',  cost:'$37.20',  unitCost:'$3.10' },
    { id:'i05', name:'Romaine hearts',   qty:'24 ea',  cost:'$43.20',  unitCost:'$1.80' },
    { id:'baby-arugula', name:'Baby arugula', qty:'6 lb', cost:'$48.00', unitCost:'$8.00' },
    { id:'i-shal', name:'Shallots',     qty:'4 lb',   cost:'$22.00',  unitCost:'$5.50' },
    { id:'i-leek', name:'Leeks',        qty:'8 ea',   cost:'$14.40',  unitCost:'$1.80' },
    { id:'i-fenn', name:'Fennel bulbs', qty:'6 ea',   cost:'$13.20',  unitCost:'$2.20' },
    { id:'i-mint', name:'Fresh mint',   qty:'8 bnch', cost:'$28.00',  unitCost:'$3.50' },
    { id:'i-basil',name:'Genovese basil',qty:'6 bnch',cost:'$22.20',  unitCost:'$3.70' },
  ];

  return (
    <>
      <div style={{ width:340, background:t.panel, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0 }}>
        <div style={{ padding:'14px 16px 10px', borderBottom:`1px solid ${t.border}` }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8 }}>
            <div style={{ fontSize:14, fontWeight:700, letterSpacing:-0.1 }}>Purchase orders</div>
            <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>7 open</div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, padding:'5px 9px' }}>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>filter:</span>
            <span style={{ flex:1, fontFamily:window.cmdMono, fontSize:11, color:t.fg }}>status:open vendor:*</span>
          </div>
          <div style={{ display:'flex', gap:6, marginTop:8 }}>
            {[['all',5],['draft',1],['sent',2],['rcvd',2]].map(([k,n],i) => (
              <span key={k} style={{
                padding:'4px 9px', fontFamily:window.cmdMono, fontSize:10.5, fontWeight:600, borderRadius:99,
                background: i===2?t.accentBg:t.panel2, border:`1px solid ${i===2?t.accent:t.border}`,
                color: i===2?t.fg:t.fg2,
              }}>{k} <span style={{ color:t.fg3 }}>{n}</span></span>
            ))}
          </div>
        </div>
        <div style={{ flex:1, overflow:'auto' }}>
          {PURCHASE_ORDERS.map(po => {
            const tone = po.status==='draft'?'info' : po.status==='sent'?'warn' : 'ok';
            const isSel = po.id === sel.id;
            return (
              <div key={po.id} style={{
                padding:'12px 16px', borderBottom:`1px solid ${t.border}`,
                background: isSel ? t.accentBg : 'transparent',
                borderLeft: isSel ? `2px solid ${t.accent}` : '2px solid transparent',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, fontWeight:600 }}>{po.id}</span>
                  <Pill t={t} status={tone}>{po.status}</Pill>
                </div>
                <div style={{ fontSize:12.5, fontWeight:600 }}>{po.vendor}</div>
                <div style={{ display:'flex', justifyContent:'space-between', marginTop:3, fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, fontVariantNumeric:'tabular-nums' }}>
                  <span>{po.items} lines</span>
                  <span>{po.date}</span>
                  <span style={{ color:t.fg }}>${po.total.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg, minWidth:0 }}>
        <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
          {['order.tsx','docs.tsx','history.tsx'].map((x,i)=>(
            <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
          ))}
          <div style={{ flex:1 }} />
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>DUPLICATE</div>
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>EDIT</div>
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>RESEND  ⌘R</div>
        </div>
        <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>PO-4820</span>
            <Pill t={t} status="warn">sent</Pill>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>· sent Apr 30 · ETA May 1</span>
          </div>
          <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Lancaster · 8 lines</h1>
          <div style={{ fontSize:13, color:t.fg2, marginBottom:18 }}>cutoff Tue 12:00 · lead 1d · ack from rep · invoice pending</div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
            <StatTile t={t} label="LINES" value="8" sub="produce only" />
            <StatTile t={t} label="ORDER TOTAL" value="$318.20" sub="net 14d" />
            <StatTile t={t} label="VS LAST WK" value="−$32" sub="↘ 9% volume" tone="ok" />
            <StatTile t={t} label="DELIVERY" value="May 1" sub="06:00–08:00" />
          </div>

          <Caption t={t} right="8 items">ORDER_LINES.TSV</Caption>
          <Card t={t} style={{ padding:0, marginBottom:14 }}>
            <div style={{ display:'grid', gridTemplateColumns:'70px 1fr 90px 90px 90px', padding:'8px 14px', borderBottom:`1px solid ${t.border}`, fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5 }}>
              <span>id</span><span>name</span><span>qty</span><span>unit $</span><span style={{textAlign:'right'}}>line $</span>
            </div>
            {lines.map((li,i) => (
              <div key={li.id} style={{ display:'grid', gridTemplateColumns:'70px 1fr 90px 90px 90px', alignItems:'center', padding:'9px 14px', borderTop: i===0?'none':`1px dashed ${t.border}` }}>
                <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{li.id}</span>
                <span style={{ fontSize:12.5, fontWeight:500 }}>{li.name}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{li.qty}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{li.unitCost}</span>
                <span style={{ fontFamily:window.cmdMono, fontSize:11.5, fontWeight:600, color:t.fg, fontVariantNumeric:'tabular-nums', textAlign:'right' }}>{li.cost}</span>
              </div>
            ))}
            <div style={{ display:'grid', gridTemplateColumns:'70px 1fr 90px 90px 90px', alignItems:'center', padding:'10px 14px', borderTop:`1px solid ${t.borderStrong}`, background:t.panel2 }}>
              <span></span>
              <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5 }}>SUBTOTAL · 8 LINES</span>
              <span></span><span></span>
              <span style={{ fontFamily:window.cmdMono, fontSize:13, fontWeight:700, fontVariantNumeric:'tabular-nums', textAlign:'right' }}>$318.20</span>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
};

// =================================================================
// 6. VENDORS — list pane (vendors) + detail (vendor profile)
// =================================================================
const ScreenVendors = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const { VENDORS } = window.IM_DATA;
  const sel = VENDORS[3]; // Samuels

  return (
    <>
      <div style={{ width:300, background:t.panel, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0 }}>
        <div style={{ padding:'14px 16px 10px', borderBottom:`1px solid ${t.border}` }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between' }}>
            <div style={{ fontSize:14, fontWeight:700, letterSpacing:-0.1 }}>Vendors</div>
            <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>6 active</div>
          </div>
        </div>
        <div style={{ flex:1, overflow:'auto' }}>
          {VENDORS.map(v => {
            const isSel = v.name === sel.name;
            return (
              <div key={v.name} style={{
                padding:'12px 16px', borderBottom:`1px solid ${t.border}`,
                background: isSel ? t.accentBg : 'transparent',
                borderLeft: isSel ? `2px solid ${t.accent}` : '2px solid transparent',
              }}>
                <div style={{ fontSize:13, fontWeight:600 }}>{v.name}</div>
                <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, marginTop:3 }}>{v.categories.toLowerCase()}</div>
                <div style={{ fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3, marginTop:2 }}>lead {v.lead}d · cutoff {v.cutoff}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg, minWidth:0 }}>
        <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
          {['profile.tsx','catalog.tsx','orders.tsx','contacts.tsx'].map((x,i)=>(
            <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
          ))}
          <div style={{ flex:1 }} />
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>EDIT</div>
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>+ NEW PO  ⌘N</div>
        </div>
        <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>v04</span>
            <Pill t={t} status="ok">active</Pill>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>· vendor since 2019</span>
          </div>
          <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>{sel.name}</h1>
          <div style={{ fontSize:13, color:t.fg2, marginBottom:18 }}>{sel.categories} · sales rep Tony N. · 410-555-0184</div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
            <StatTile t={t} label="LEAD TIME" value={`${sel.lead}d`} sub="standard" />
            <StatTile t={t} label="CUTOFF" value={sel.cutoff} sub={sel.days.toLowerCase()} />
            <StatTile t={t} label="SPEND / WK" value="$612" sub="↗ 4% vs avg" />
            <StatTile t={t} label="ON-TIME %" value="96%" sub="trailing 90d" tone="ok" />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:14 }}>
            <Card t={t}>
              <Caption t={t} right="6 items">CATALOG</Caption>
              {[
                ['i03','Atlantic salmon','$14.20/lb','par 12'],
                ['i12','Maine lobster','$28.00/lb','par 8'],
                ['i-tuna','Yellowfin tuna','$24.00/lb','par 6'],
                ['i-scal','Sea scallops','$26.50/lb','par 4'],
                ['i-shri','Wild shrimp','$18.00/lb','par 10'],
                ['i-clam','Littleneck clams','$0.45/ea','par 100'],
              ].map(([id,name,price,par],i) => (
                <div key={id} style={{ display:'grid', gridTemplateColumns:'60px 1fr 110px 60px', alignItems:'center', padding:'8px 0', borderTop:i===0?'none':`1px dashed ${t.border}` }}>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{id}</span>
                  <span style={{ fontSize:12.5, fontWeight:500 }}>{name}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg, fontVariantNumeric:'tabular-nums' }}>{price}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3, textAlign:'right' }}>{par}</span>
                </div>
              ))}
            </Card>
            <Card t={t}>
              <Caption t={t}>PROPERTIES.JSON</Caption>
              {[
                ['categories', `"${sel.categories}"`],
                ['lead_time_days', sel.lead],
                ['cutoff', `"${sel.cutoff}"`],
                ['delivery_days', `"${sel.days}"`],
                ['terms', '"net 14d"'],
                ['min_order', '$200.00'],
                ['rep', '"Tony N."'],
                ['phone', '"410-555-0184"'],
                ['email', '"orders@samuels.fish"'],
              ].map(([k,v],i) => (
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'7px 0', borderTop:i===0?'none':`1px dashed ${t.border}`, fontFamily:window.cmdMono, fontSize:11.5 }}>
                  <span style={{ color:t.fg3 }}>{k}</span>
                  <span style={{ color:t.fg }}>{v}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
};

// =================================================================
// 7. RECIPES — list pane (recipes) + detail (recipe spec)
// =================================================================
const ScreenRecipes = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const recipes = [
    { id:'r-01', name:'Pan-roasted salmon',     yield:'4 portions', cost:5.84, sell:28, soldWk:84 },
    { id:'r-02', name:'Caesar salad',           yield:'1 entree',   cost:1.92, sell:14, soldWk:62 },
    { id:'r-03', name:'Heirloom caprese',       yield:'1 starter',  cost:2.40, sell:13, soldWk:48 },
    { id:'r-04', name:'Lobster roll',           yield:'1 sandwich', cost:6.20, sell:32, soldWk:46 },
    { id:'r-05', name:'Buttered brioche bun',   yield:'12 buns',    cost:0.40, sell: 0, soldWk:120 },
    { id:'r-06', name:'Hollandaise',            yield:'1 cup',      cost:1.10, sell: 0, soldWk:36 },
  ];
  const sel = recipes[0];
  const ingredients = [
    { id:'i03', name:'Atlantic salmon',  qty:'24 oz',   cost:'$3.55', pct:'61%' },
    { id:'i07', name:'Unsalted butter',  qty:'2 oz',    cost:'$0.49', pct:'8%' },
    { id:'i04', name:'Heirloom tomato',  qty:'8 oz',    cost:'$1.55', pct:'27%' },
    { id:'i11', name:'Smoked paprika',   qty:'0.1 oz',  cost:'$0.11', pct:'2%' },
    { id:'i09', name:'Olive oil EV',     qty:'1 oz',    cost:'$0.30', pct:'5%' },
    { id:'i-lem',name:'Lemon',            qty:'½ ea',    cost:'$0.18', pct:'3%' },
  ];

  return (
    <>
      <div style={{ width:340, background:t.panel, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0 }}>
        <div style={{ padding:'14px 16px 10px', borderBottom:`1px solid ${t.border}` }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8 }}>
            <div style={{ fontSize:14, fontWeight:700, letterSpacing:-0.1 }}>Recipes</div>
            <div style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>32 total</div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6, background:t.panel2, border:`1px solid ${t.border}`, borderRadius:5, padding:'5px 9px' }}>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>filter:</span>
            <span style={{ flex:1, fontFamily:window.cmdMono, fontSize:11, color:t.fg }}>menu:dinner</span>
          </div>
        </div>
        <div style={{ flex:1, overflow:'auto' }}>
          {recipes.map(r => {
            const isSel = r.id === sel.id;
            const margin = r.sell ? Math.round((1 - r.cost/r.sell) * 100) : null;
            return (
              <div key={r.id} style={{
                padding:'10px 16px', borderBottom:`1px solid ${t.border}`,
                background: isSel ? t.accentBg : 'transparent',
                borderLeft: isSel ? `2px solid ${t.accent}` : '2px solid transparent',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ flex:1, fontSize:13, fontWeight:600 }}>{r.name}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>{r.id}</span>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:4, fontFamily:window.cmdMono, fontSize:10.5, color:t.fg3 }}>
                  <span>{r.yield}</span>
                  <span style={{ flex:1 }} />
                  <span style={{ color:t.fg, fontVariantNumeric:'tabular-nums' }}>${r.cost.toFixed(2)}</span>
                  {r.sell ? <span style={{ color: margin>=70?t.ok:margin>=50?t.warn:t.danger, fontVariantNumeric:'tabular-nums' }}>{margin}%</span> : <span style={{ color:t.fg3 }}>sub</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg, minWidth:0 }}>
        <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
          {['recipe.tsx','method.tsx','allergens.tsx','sales.tsx'].map((x,i)=>(
            <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
          ))}
          <div style={{ flex:1 }} />
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>DUPLICATE</div>
          <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>EDIT  ⌘E</div>
        </div>
        <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>r-01</span>
            <Pill t={t} status="ok">active</Pill>
            <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>· menu: dinner · station: line 1</span>
          </div>
          <h1 style={{ margin:'0 0 4px', fontSize:26, fontWeight:700, letterSpacing:-0.4 }}>{sel.name}</h1>
          <div style={{ fontSize:13, color:t.fg2, marginBottom:18 }}>4-portion yield · plated · last edited 6d ago by Chef Reyes</div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:14 }}>
            <StatTile t={t} label="PLATE COST" value={`$${sel.cost.toFixed(2)}`} sub="6 ingredients" />
            <StatTile t={t} label="MENU PRICE" value={`$${sel.sell}.00`} sub="dinner entrees" />
            <StatTile t={t} label="MARGIN" value={`${Math.round((1 - sel.cost/sel.sell)*100)}%`} sub="vs target 70%" tone="ok" />
            <StatTile t={t} label="SOLD / WK" value={sel.soldWk} sub="↗ 8% vs prior" />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:14 }}>
            <Card t={t}>
              <Caption t={t} right="6 lines · plate cost $5.84">INGREDIENTS.TSV</Caption>
              <div style={{ display:'grid', gridTemplateColumns:'60px 1fr 80px 70px 50px', padding:'4px 0 8px', borderBottom:`1px solid ${t.border}`, fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5 }}>
                <span>id</span><span>name</span><span>qty</span><span>cost</span><span style={{textAlign:'right'}}>%</span>
              </div>
              {ingredients.map((ig,i) => (
                <div key={ig.id} style={{ display:'grid', gridTemplateColumns:'60px 1fr 80px 70px 50px', alignItems:'center', padding:'8px 0', borderTop:i===0?'none':`1px dashed ${t.border}` }}>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{ig.id}</span>
                  <span style={{ fontSize:12.5, fontWeight:500 }}>{ig.name}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{ig.qty}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg, fontVariantNumeric:'tabular-nums' }}>{ig.cost}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3, textAlign:'right' }}>{ig.pct}</span>
                </div>
              ))}
            </Card>
            <Card t={t}>
              <Caption t={t}>PROPERTIES.JSON</Caption>
              {[
                ['menu', '"dinner"'],
                ['station', '"line 1"'],
                ['yield', '"4 portions"'],
                ['prep_time', '"8 min"'],
                ['allergens', '["fish"]'],
                ['plate_cost', '$5.84'],
                ['menu_price', '$28.00'],
                ['target_margin', '70%'],
              ].map(([k,v],i) => (
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'7px 0', borderTop:i===0?'none':`1px dashed ${t.border}`, fontFamily:window.cmdMono, fontSize:11.5 }}>
                  <span style={{ color:t.fg3 }}>{k}</span>
                  <span style={{ color:t.fg }}>{v}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
};

// =================================================================
// 8. RESTOCK — full-width auto-generated reorder list w/ vendor groups
// =================================================================
const ScreenRestock = ({ dark }) => {
  const t = window.cmdTokens(dark);
  const groups = [
    { vendor:'Sysco',     cutoff:'15:00 Mon Wed Fri', items:[
      { id:'i01', name:'Beef tenderloin', cur:'12.4 lb', par:'18 lb', sug:'8 lb',  cost:'$179.20', urgency:'low' },
      { id:'i09', name:'Olive oil EV',    cur:'2.1 gal', par:'6 gal', sug:'4 gal', cost:'$152.00', urgency:'low' },
    ]},
    { vendor:'Samuels',   cutoff:'11:00 Mon Thu', items:[
      { id:'i03', name:'Atlantic salmon', cur:'4.2 lb',  par:'12 lb', sug:'10 lb', cost:'$142.00', urgency:'low' },
      { id:'i12', name:'Maine lobster',   cur:'0 lb',    par:'8 lb',  sug:'8 lb',  cost:'$224.00', urgency:'out' },
    ]},
    { vendor:'Lancaster', cutoff:'12:00 Tue Fri', items:[
      { id:'i05', name:'Romaine hearts',  cur:'0 ea',    par:'24 ea', sug:'24 ea', cost:'$43.20',  urgency:'out' },
    ]},
    { vendor:'H&S Bakery',cutoff:'16:00 daily', items:[
      { id:'i10', name:'Brioche buns',    cur:'36 ea',   par:'48 ea', sug:'24 ea', cost:'$13.20',  urgency:'low' },
    ]},
  ];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:t.bg }}>
      <div style={{ height:36, background:t.panel, borderBottom:`1px solid ${t.border}`, display:'flex', alignItems:'center', padding:'0 18px', gap:18, flexShrink:0 }}>
        {['suggested.tsx','manual.tsx'].map((x,i)=>(
          <div key={x} style={{ padding:'8px 0', fontFamily:window.cmdMono, fontSize:12, color: i===0?t.fg:t.fg2, borderBottom: i===0?`2px solid ${t.accent}`:'2px solid transparent' }}>{x}</div>
        ))}
        <div style={{ flex:1 }} />
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, padding:'4px 10px', border:`1px solid ${t.border}`, borderRadius:4, color:t.fg2 }}>EXPORT CSV</div>
        <div style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, padding:'4px 10px', borderRadius:4, background:t.accent, color:'#000' }}>CREATE 4 POs  ⏎</div>
      </div>
      <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
        <h1 style={{ margin:'0 0 4px', fontSize:24, fontWeight:700, letterSpacing:-0.4 }}>Suggested restock</h1>
        <div style={{ fontSize:13, color:t.fg2, marginBottom:14 }}>Auto-generated from on-hand &lt; par. 6 items · 4 vendors · est $577.40</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
          <StatTile t={t} label="ITEMS BELOW PAR" value="6" sub="of 142" />
          <StatTile t={t} label="OUT OF STOCK" value="2" sub="urgent" tone="danger" />
          <StatTile t={t} label="TOTAL ESTIMATE" value="$577.40" sub="across 4 POs" />
          <StatTile t={t} label="NEXT CUTOFF" value="11:00" sub="Samuels (Mon)" tone="warn" />
        </div>

        {groups.map((g,gi)=>(
          <div key={g.vendor} style={{ marginBottom:14 }}>
            <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:8, padding:'0 2px' }}>
              <span style={{ fontFamily:window.cmdMono, fontSize:10.5, fontWeight:700, color:t.fg3, textTransform:'uppercase', letterSpacing:0.6 }}>VENDOR / {g.vendor.toUpperCase().replace(/\s+/g,'_')}</span>
              <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.fg3 }}>cutoff {g.cutoff}</span>
              <span style={{ flex:1 }} />
              <span style={{ fontFamily:window.cmdMono, fontSize:10, color:t.accent }}>+ add line</span>
            </div>
            <Card t={t} style={{ padding:0 }}>
              <div style={{ display:'grid', gridTemplateColumns:'24px 60px 1fr 100px 100px 110px 90px 80px', padding:'8px 14px', borderBottom:`1px solid ${t.border}`, fontFamily:window.cmdMono, fontSize:9.5, color:t.fg3, textTransform:'uppercase', letterSpacing:0.5 }}>
                <span></span><span>id</span><span>name</span><span>on hand</span><span>par</span><span>order qty</span><span>est cost</span><span style={{textAlign:'right'}}>state</span>
              </div>
              {g.items.map((it,i)=>(
                <div key={it.id} style={{ display:'grid', gridTemplateColumns:'24px 60px 1fr 100px 100px 110px 90px 80px', alignItems:'center', padding:'10px 14px', borderTop:i===0?'none':`1px solid ${t.border}`, background: it.urgency==='out' ? t.dangerBg : 'transparent' }}>
                  <span style={{ width:14, height:14, borderRadius:3, background:t.accent, display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, color:'#000', fontWeight:700 }}>✓</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11, color:t.fg3 }}>{it.id}</span>
                  <span style={{ fontSize:12.5, fontWeight:600 }}>{it.name}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color: it.urgency==='out'?t.danger:t.fg, fontVariantNumeric:'tabular-nums' }}>{it.cur}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg2, fontVariantNumeric:'tabular-nums' }}>{it.par}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:12, fontWeight:600, color:t.fg, fontVariantNumeric:'tabular-nums' }}>{it.sug}</span>
                  <span style={{ fontFamily:window.cmdMono, fontSize:11.5, color:t.fg, fontVariantNumeric:'tabular-nums' }}>{it.cost}</span>
                  <span style={{ textAlign:'right' }}><Pill t={t} status={it.urgency==='out'?'out':'low'}>{it.urgency}</Pill></span>
                </div>
              ))}
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
};

window.ScreenPOs = ScreenPOs;
window.ScreenVendors = ScreenVendors;
window.ScreenRecipes = ScreenRecipes;
window.ScreenRestock = ScreenRestock;
