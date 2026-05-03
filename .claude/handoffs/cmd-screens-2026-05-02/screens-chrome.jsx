// Shared chrome (sidebar + title bar + status bar) for all Command screens.
// Each screen file imports CmdChrome and renders its detail-pane content as children.

window.cmdTokens = (dark) => dark ? {
  bg:'#08090C', sidebar:'#0E1014', panel:'#12141A', panel2:'#181B22',
  border:'rgba(255,255,255,0.06)', borderStrong:'rgba(255,255,255,0.12)',
  fg:'#E6E8EC', fg2:'#9BA0AB', fg3:'#5C6270',
  accent:'oklch(0.78 0.16 145)', accentBg:'oklch(0.30 0.08 145 / 0.4)',
  ok:'#5CB832', warn:'#E0A030', danger:'#E04848', info:'#5AA8F0',
  okBg:'rgba(92,184,50,0.15)', warnBg:'rgba(224,160,48,0.15)', dangerBg:'rgba(224,72,72,0.15)', infoBg:'rgba(90,168,240,0.15)',
} : {
  bg:'#FAFAF8', sidebar:'#FFFFFF', panel:'#FFFFFF', panel2:'#F4F4F0',
  border:'rgba(20,20,20,0.07)', borderStrong:'rgba(20,20,20,0.14)',
  fg:'#0E1014', fg2:'#5A5F68', fg3:'#9094A0',
  accent:'oklch(0.50 0.16 145)', accentBg:'oklch(0.93 0.06 145 / 1)',
  ok:'#3B6D11', warn:'#854F0B', danger:'#791F1F', info:'#185FA5',
  okBg:'#EAF3DE', warnBg:'#FAEEDA', dangerBg:'#FCEBEB', infoBg:'#E6F1FB',
};
window.cmdSans = '"Inter Tight", "Inter", system-ui, sans-serif';
window.cmdMono = '"JetBrains Mono", "SF Mono", ui-monospace, monospace';

const CmdChrome = ({ dark, section, breadcrumbSlug, statusLeft, statusRight, children }) => {
  const t = window.cmdTokens(dark);
  const sans = window.cmdSans;
  const mono = window.cmdMono;
  const tree = [
    { name:'Operations', children:['Dashboard','Inventory','EOD count','Waste log','Receiving'] },
    { name:'Planning',   children:['Purchase orders','Vendors','Recipes','Restock'] },
    { name:'Insights',   children:['Reconciliation','POS imports','Audit log','Reports'] },
  ];
  const slug = breadcrumbSlug || section.toLowerCase().replace(/\s+/g,'-');
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
          inv://towson — {slug}
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', fontFamily:mono, fontSize:10, color:t.fg3 }}>
          <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:6, height:6, borderRadius:99, background:t.ok }} /> connected</span>
        </div>
      </div>

      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
        {/* Sidebar */}
        <div style={{ width:240, background:t.sidebar, borderRight:`1px solid ${t.border}`, display:'flex', flexDirection:'column', overflow:'hidden', flexShrink:0 }}>
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
                  <div key={c} style={{
                    padding:'4px 14px 4px 26px', fontSize:12.5,
                    background: section===c ? t.accentBg : 'transparent',
                    color: section===c ? t.fg : t.fg2,
                    borderLeft: section===c ? `2px solid ${t.accent}` : '2px solid transparent',
                  }}>{c}</div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ padding:'8px 14px', borderTop:`1px solid ${t.border}`, display:'flex', alignItems:'center', justifyContent:'space-between', fontFamily:mono, fontSize:10, color:t.fg3 }}>
            <span style={{ display:'flex', alignItems:'center', gap:5 }}><span style={{ width:6, height:6, borderRadius:99, background:t.accent }} />admin</span>
            <span>EOD 18/24</span>
          </div>
        </div>

        {/* Detail area (children render the screen-specific content) */}
        <div style={{ flex:1, display:'flex', overflow:'hidden', minWidth:0 }}>
          {children}
        </div>
      </div>

      {/* Status bar */}
      <div style={{ height:24, background:t.sidebar, borderTop:`1px solid ${t.border}`, padding:'0 14px', display:'flex', alignItems:'center', justifyContent:'space-between', fontFamily:mono, fontSize:10, color:t.fg3, flexShrink:0 }}>
        <span>{statusLeft || <><span style={{display:'inline-flex', alignItems:'center', gap:5}}><span style={{width:6,height:6,borderRadius:99,background:t.ok,display:'inline-block'}}/>synced</span></>}</span>
        <span>{statusRight || <>UTF-8&nbsp;&nbsp;LF&nbsp;&nbsp;<span style={{color:t.accent}}>⌘K palette</span></>}</span>
      </div>
    </div>
  );
};

window.CmdChrome = CmdChrome;
