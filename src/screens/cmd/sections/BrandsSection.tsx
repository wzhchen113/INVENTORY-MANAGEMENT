import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { useIsSuperAdmin } from '../../../hooks/useRole';
import { useIsCompact } from '../../../theme/breakpoints';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { PropertiesJson } from '../../../components/cmd/PropertiesJson';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { BrandFormDrawer } from '../../../components/cmd/BrandFormDrawer';
import { InviteAdminDrawer } from '../../../components/cmd/InviteAdminDrawer';
import { Brand, User } from '../../../types';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);
const fmtDate = (iso?: string | null) => (iso ? iso.slice(0, 10) : '—');

type BrandStats = Brand & { storeCount: number; memberCount: number; catalogIngredientCount: number };

// Spec 012b §3 — list + detail two-pane (mirrors VendorsSection.tsx).
// Visible only when super-admin. Defensive empty state when accessed by
// a non-super-admin (sidebar gate filters it out, but URL trickery /
// palette injection could still reach this branch).
export default function BrandsSection() {
  const C = useCmdColors();
  const isSuperAdmin = useIsSuperAdmin();
  const isCompact = useIsCompact();
  const allStores = useStore((s) => s.stores);
  const loadBrandsList = useStore((s) => s.loadBrandsList);
  // Cleanup #2 — store-owned brand stats + admins. The screen no longer
  // imports db.ts directly; data flows through useStore actions like every
  // other section under src/screens/cmd/sections/.
  const brandStats = useStore((s) => s.brandStats) as BrandStats[];
  const loadBrandStats = useStore((s) => s.loadBrandStats);
  const brandAdminsByBrandId = useStore((s) => s.brandAdminsByBrandId);
  const loadBrandAdmins = useStore((s) => s.loadBrandAdmins);

  const [loadingStats, setLoadingStats] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // tab ids intentionally match the file-extension style used across
  // cmd sections (mirrors VendorsSection).
  const [tabId, setTabId] = React.useState('profile.tsx');
  const [newDrawerOpen, setNewDrawerOpen] = React.useState(false);
  const [inviteDrawerOpen, setInviteDrawerOpen] = React.useState(false);
  const [loadingAdmins, setLoadingAdmins] = React.useState(false);
  // Phone-only — flip back to the list pane when no brand selected.
  const [showDetail, setShowDetail] = React.useState(false);

  // Initial load — fetch stats list + lite picker list once on mount.
  // createBrand re-triggers loadBrandStats from the store so the list pane
  // reflects new brands without requiring this effect to re-fire.
  React.useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      setLoadingStats(true);
      await loadBrandStats();
      if (!cancelled) setLoadingStats(false);
      loadBrandsList().catch(() => { /* logged inside */ });
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin, loadBrandStats, loadBrandsList]);

  // Refetch admins when selection changes (or after an invite). Result
  // lives in `brandAdminsByBrandId[selectedId]`.
  React.useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingAdmins(true);
    loadBrandAdmins(selectedId).finally(() => {
      if (!cancelled) setLoadingAdmins(false);
    });
    return () => { cancelled = true; };
  }, [selectedId, inviteDrawerOpen, loadBrandAdmins]);

  const admins: User[] = (selectedId && brandAdminsByBrandId[selectedId]) || [];

  // Auto-select the first brand on first non-empty render so the detail
  // pane has something to show. Only on desktop/tablet — phone keeps the
  // list view as the entry point.
  React.useEffect(() => {
    if (isCompact) return;
    if (selectedId && brandStats.find((b) => b.id === selectedId)) return;
    setSelectedId(brandStats[0]?.id || null);
  }, [brandStats, selectedId, isCompact]);

  if (!isSuperAdmin) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={[Type.h2, { color: C.fg }]}>Not available</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, marginTop: 6 }}>
          Brands management is super-admin only.
        </Text>
      </View>
    );
  }

  const sel = brandStats.find((b) => b.id === selectedId) || null;
  const selStores = sel ? allStores.filter((s) => s.brandId === sel.id) : [];

  const refreshAfterInvite = () => {
    if (selectedId) loadBrandAdmins(selectedId).catch(() => {});
  };

  // Phone — single pane. Show list, then detail on selection (with a
  // back affordance). Tablet/desktop renders both panes side-by-side.
  if (isCompact && showDetail && sel) {
    return (
      <>
        <DetailPane
          sel={sel}
          selStores={selStores}
          tabId={tabId}
          setTabId={setTabId}
          admins={admins}
          loadingAdmins={loadingAdmins}
          onInvite={() => setInviteDrawerOpen(true)}
          onBack={() => setShowDetail(false)}
        />
        <InviteAdminDrawer
          visible={inviteDrawerOpen}
          brandId={sel.id}
          brandName={sel.name}
          onClose={() => setInviteDrawerOpen(false)}
          onInvited={refreshAfterInvite}
        />
      </>
    );
  }

  if (isCompact) {
    return (
      <>
        <ListPane
          brandStats={brandStats}
          loadingStats={loadingStats}
          selectedId={selectedId}
          onSelect={(id) => { setSelectedId(id); setShowDetail(true); }}
          onNew={() => setNewDrawerOpen(true)}
        />
        <BrandFormDrawer visible={newDrawerOpen} onClose={() => setNewDrawerOpen(false)} />
      </>
    );
  }

  // Desktop / tablet — two-pane.
  return (
    <>
      <ListPane
        brandStats={brandStats}
        loadingStats={loadingStats}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id)}
        onNew={() => setNewDrawerOpen(true)}
      />

      <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {brandStats.length === 0 ? 'no brands yet' : 'select a brand'}
            </Text>
          </View>
        ) : (
          <DetailPane
            sel={sel}
            selStores={selStores}
            tabId={tabId}
            setTabId={setTabId}
            admins={admins}
            loadingAdmins={loadingAdmins}
            onInvite={() => setInviteDrawerOpen(true)}
          />
        )}
      </View>

      <BrandFormDrawer visible={newDrawerOpen} onClose={() => setNewDrawerOpen(false)} />
      {sel ? (
        <InviteAdminDrawer
          visible={inviteDrawerOpen}
          brandId={sel.id}
          brandName={sel.name}
          onClose={() => setInviteDrawerOpen(false)}
          onInvited={refreshAfterInvite}
        />
      ) : null}
    </>
  );
}

// ─── List pane ──────────────────────────────────────────────────────
function ListPane({
  brandStats, loadingStats, selectedId, onSelect, onNew,
}: {
  brandStats: BrandStats[];
  loadingStats: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const C = useCmdColors();
  const isCompact = useIsCompact();
  return (
    <View
      style={{
        // Compact tiers (phone/tablet) — full-width list pane.
        // Desktop — fixed 340 wide list pane next to the detail pane.
        width: isCompact ? '100%' : 340,
        flex: isCompact ? 1 : undefined,
        backgroundColor: C.panel,
        borderRightWidth: isCompact ? 0 : 1,
        borderRightColor: C.border,
        minHeight: 0,
      }}
    >
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}
      >
        <Text style={[Type.h2, { color: C.fg }]}>Brands</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {brandStats.length} {brandStats.length === 1 ? 'brand' : 'brands'}
          </Text>
          <TouchableOpacity
            onPress={onNew}
            style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
            accessibilityRole="button"
            accessibilityLabel="New brand"
          >
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accentFg }}>+ NEW BRAND</Text>
          </TouchableOpacity>
        </View>
      </View>
      {loadingStats ? (
        <View style={{ padding: 22 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>loading…</Text>
        </View>
      ) : brandStats.length === 0 ? (
        <View style={{ padding: 22 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            no brands yet — click "+ NEW BRAND" to create one
          </Text>
        </View>
      ) : (
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={brandStats}
          keyExtractor={(b) => b.id}
          renderItem={({ item: b }) => {
            const isSel = b.id === selectedId;
            return (
              <TouchableOpacity
                onPress={() => onSelect(b.id)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0),
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0,
                  borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  gap: 3,
                }}
              >
                <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }}>{b.name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {b.storeCount} {b.storeCount === 1 ? 'store' : 'stores'} · {b.memberCount} {b.memberCount === 1 ? 'admin' : 'admins'} · {b.catalogIngredientCount} {b.catalogIngredientCount === 1 ? 'ingredient' : 'ingredients'}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {shortId(b.id)} · created {fmtDate(b.createdAt)}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

// ─── Detail pane ────────────────────────────────────────────────────
function DetailPane({
  sel, selStores, tabId, setTabId, admins, loadingAdmins, onInvite, onBack,
}: {
  sel: BrandStats;
  selStores: ReturnType<typeof useStore.getState>['stores'];
  tabId: string;
  setTabId: (id: string) => void;
  admins: User[];
  loadingAdmins: boolean;
  onInvite: () => void;
  /** Phone-only — back-to-list affordance. Omitted on desktop/tablet. */
  onBack?: () => void;
}) {
  const C = useCmdColors();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'profile.tsx', label: 'profile.tsx' },
          { id: 'members.tsx', label: 'members.tsx' },
          { id: 'stores.tsx',  label: 'stores.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          onBack ? (
            <TouchableOpacity
              onPress={onBack}
              style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
              accessibilityRole="button"
              accessibilityLabel="Back to brands list"
            >
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>‹ BACK</Text>
            </TouchableOpacity>
          ) : null
        }
      />
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        {/* Hero */}
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
            <StatusPill status={sel.deletedAt ? 'out' : 'ok'} label={sel.deletedAt ? 'DELETED' : 'ACTIVE'} />
          </View>
          <Text style={[Type.h1, { color: C.fg }]}>{sel.name}</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            tenant · {sel.storeCount} stores · {sel.memberCount} admins · {sel.catalogIngredientCount} ingredients · created {fmtDate(sel.createdAt)}
          </Text>
        </View>

        {tabId === 'profile.tsx' ? (
          <>
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <StatCard label="Stores"      value={String(sel.storeCount)}             sub="active" />
              <StatCard label="Admins"      value={String(sel.memberCount)}            sub="profile rows" />
              <StatCard label="Ingredients" value={String(sel.catalogIngredientCount)} sub="brand catalog" />
              <StatCard label="ID"          value={shortId(sel.id)}                    sub="brand uuid" />
              <StatCard label="Created"     value={fmtDate(sel.createdAt)}             sub="iso date" />
            </View>
            <View
              style={{
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
                padding: 14,
                gap: 6,
              }}
            >
              <SectionCaption tone="fg3" size={10.5}>properties.json</SectionCaption>
              <PropertiesJson
                entries={[
                  { key: 'id',         value: `"${sel.id}"` },
                  { key: 'name',       value: `"${sel.name}"` },
                  { key: 'created_at', value: `"${sel.createdAt || '—'}"` },
                  { key: 'deleted_at', value: sel.deletedAt ? `"${sel.deletedAt}"` : 'null' },
                  { key: 'stores',      value: String(sel.storeCount) },
                  { key: 'admins',      value: String(sel.memberCount) },
                  { key: 'ingredients', value: String(sel.catalogIngredientCount) },
                ]}
              />
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              Note: brand renaming and soft-delete are out of scope for 012b. Use the
              Supabase SQL editor for now; UI controls land in 012c.
            </Text>
          </>
        ) : tabId === 'members.tsx' ? (
          <MembersTab admins={admins} loading={loadingAdmins} onInvite={onInvite} />
        ) : tabId === 'stores.tsx' ? (
          <StoresTab stores={selStores} />
        ) : null}
      </ScrollView>
    </View>
  );
}

// ─── members.tsx ────────────────────────────────────────────────────
function MembersTab({ admins, loading, onInvite }: { admins: User[]; loading: boolean; onInvite: () => void }) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={[Type.h2, { color: C.fg }]}>Admins</Text>
        <TouchableOpacity
          onPress={onInvite}
          style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
          accessibilityRole="button"
          accessibilityLabel="Invite admin"
        >
          <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>+ INVITE ADMIN</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>loading…</Text>
      ) : admins.length === 0 ? (
        <View
          style={{
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            padding: 22,
            alignItems: 'center',
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
            no admins yet — click "+ INVITE ADMIN" to onboard the first one
          </Text>
        </View>
      ) : (
        <View
          style={{
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            overflow: 'hidden',
          }}
        >
          {admins.map((u, i) => (
            <View
              key={u.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: C.border,
              }}
            >
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  backgroundColor: u.color || C.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#FFF' }}>{u.initials}</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }}>{u.name || '—'}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
                  {u.email || '(email not loaded)'} · {u.stores.length} stores
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <View
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: CmdRadius.xs,
                    backgroundColor: C.panel2,
                    borderWidth: 1,
                    borderColor: C.border,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.fg2, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    {u.role}
                  </Text>
                </View>
                <StatusPill
                  status={u.status === 'active' ? 'ok' : 'low'}
                  label={u.status === 'active' ? 'ACTIVE' : 'PENDING'}
                />
              </View>
            </View>
          ))}
        </View>
      )}
      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
        Read-only in 012b. Suspend / delete / role-change controls land in 012c.
      </Text>
    </View>
  );
}

// ─── stores.tsx ─────────────────────────────────────────────────────
function StoresTab({ stores }: { stores: ReturnType<typeof useStore.getState>['stores'] }) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 10 }}>
      <Text style={[Type.h2, { color: C.fg }]}>Stores</Text>
      {stores.length === 0 ? (
        <View
          style={{
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            padding: 22,
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
            no stores yet
          </Text>
          <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg3, textAlign: 'center', maxWidth: 360 }}>
            Switch into this brand via the header brand picker, then add a store
            from the Inventory section's store-switcher menu.
          </Text>
        </View>
      ) : (
        <View
          style={{
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            overflow: 'hidden',
          }}
        >
          {stores.map((s, i) => (
            <View
              key={s.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: C.border,
              }}
            >
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 70 }}>
                {shortId(s.id)}
              </Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }}>{s.name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
                  {s.address || '(no address)'}
                </Text>
              </View>
              <StatusPill
                status={s.status === 'active' ? 'ok' : 'low'}
                label={s.status === 'active' ? 'ACTIVE' : 'INACTIVE'}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
