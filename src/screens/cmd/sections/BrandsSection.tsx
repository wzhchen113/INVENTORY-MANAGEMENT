import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, TextInput, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
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
import { StoreFormDrawer } from '../../../components/cmd/StoreFormDrawer';
import { InviteAdminDrawer } from '../../../components/cmd/InviteAdminDrawer';
import { TypeToConfirmModal } from '../../../components/cmd/TypeToConfirmModal';
import { CascadePreviewModal } from '../../../components/cmd/CascadePreviewModal';
import { confirmAction } from '../../../utils/confirmAction';
import { Brand, User } from '../../../types';
import { useT } from '../../../hooks/useT';
import { userStatusLabel } from '../../../utils/enumLabels';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);
const fmtDate = (iso?: string | null) => (iso ? iso.slice(0, 10) : '—');

// Spec 012c — 30-day grace window for restore + purge.
const GRACE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSinceDeleted(deletedAt?: string | null): number | null {
  if (!deletedAt) return null;
  const t = new Date(deletedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / MS_PER_DAY);
}

type BrandStats = Brand & { storeCount: number; memberCount: number; catalogIngredientCount: number };
type ListTab = 'active' | 'trash';

// Spec 012b §3 — list + detail two-pane (mirrors VendorsSection.tsx).
// Spec 012c §8 — adds Active/Trash sub-tabs, inline rename, soft-delete /
// restore / purge buttons, and per-row Demote/Delete on the members tab.
// Visible only when super-admin.
export default function BrandsSection() {
  const C = useCmdColors();
  const T = useT();
  const isSuperAdmin = useIsSuperAdmin();
  const isCompact = useIsCompact();
  const allStores = useStore((s) => s.stores);
  const loadBrandsList = useStore((s) => s.loadBrandsList);
  const brandStats = useStore((s) => s.brandStats) as BrandStats[];
  const loadBrandStats = useStore((s) => s.loadBrandStats);
  const loadBrandStatsIncludingDeleted = useStore((s) => s.loadBrandStatsIncludingDeleted);
  const brandAdminsByBrandId = useStore((s) => s.brandAdminsByBrandId);
  const loadBrandAdmins = useStore((s) => s.loadBrandAdmins);
  const renameBrand = useStore((s) => s.renameBrand);
  const softDeleteBrand = useStore((s) => s.softDeleteBrand);
  const restoreBrand = useStore((s) => s.restoreBrand);
  const hardDeleteBrand = useStore((s) => s.hardDeleteBrand);
  const currentUser = useStore((s) => s.currentUser);

  const [loadingStats, setLoadingStats] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('profile.tsx');
  const [listTab, setListTab] = React.useState<ListTab>('active');
  const [newDrawerOpen, setNewDrawerOpen] = React.useState(false);
  const [inviteDrawerOpen, setInviteDrawerOpen] = React.useState(false);
  const [loadingAdmins, setLoadingAdmins] = React.useState(false);
  const [showDetail, setShowDetail] = React.useState(false);

  // Spec 012c — modal state for the destructive flows.
  const [deleteBrandOpen, setDeleteBrandOpen] = React.useState(false);
  const [purgeOpen, setPurgeOpen] = React.useState(false);
  const [deleteProfileTarget, setDeleteProfileTarget] = React.useState<User | null>(null);

  // Initial load — fetch stats list + lite picker list once on mount.
  // Always loads with includeSoftDeleted=true so the Trash sub-tab is
  // ready without an extra round-trip when the operator switches tabs.
  React.useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      setLoadingStats(true);
      await loadBrandStatsIncludingDeleted();
      if (!cancelled) setLoadingStats(false);
      loadBrandsList().catch(() => { /* logged inside */ });
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin, loadBrandStatsIncludingDeleted, loadBrandsList]);

  // Refetch admins when selection changes (or after an invite).
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

  // Partition stats into active vs trash; memoize so the list pane gets
  // a stable reference between renders.
  const { activeBrands, trashBrands } = React.useMemo(() => {
    const a: BrandStats[] = [];
    const t: BrandStats[] = [];
    for (const b of brandStats) {
      (b.deletedAt ? t : a).push(b);
    }
    // Active sorted by name; Trash sorted by deletedAt DESC (most-recent
    // soft-delete first — matches the operator's mental model).
    a.sort((x, y) => x.name.localeCompare(y.name));
    t.sort((x, y) => (y.deletedAt || '').localeCompare(x.deletedAt || ''));
    return { activeBrands: a, trashBrands: t };
  }, [brandStats]);

  const visibleBrands = listTab === 'active' ? activeBrands : trashBrands;

  // Auto-select the first brand in the visible partition on first
  // non-empty render. Switching list tabs also retargets the selection
  // when the previous brand is no longer in the visible list.
  React.useEffect(() => {
    if (isCompact) return;
    if (selectedId && visibleBrands.find((b) => b.id === selectedId)) return;
    setSelectedId(visibleBrands[0]?.id || null);
  }, [visibleBrands, selectedId, isCompact]);

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

  const handleSoftDelete = async () => {
    if (!sel) return;
    const ok = await softDeleteBrand(sel.id);
    if (ok) {
      // Cleanup C1 — single toast: when soft-deleting the current brand
      // the store-side auto-swap path (useStore.softDeleteBrand) already
      // surfaces its own info toast ("Switched to All brands view"); a
      // screen-level toast here would double up. For non-current brands
      // the close + Trash count update is sufficient feedback.
      setDeleteBrandOpen(false);
      // Refresh stats so Trash count badge updates immediately.
      loadBrandStatsIncludingDeleted().catch(() => {});
    }
  };

  const handleRestore = async () => {
    if (!sel) return;
    const ok = await restoreBrand(sel.id);
    if (ok) {
      Toast.show({ type: 'success', text1: `Restored "${sel.name}"` });
      // Active list pane shows the row immediately after the partition flip.
      loadBrandStatsIncludingDeleted().catch(() => {});
      // Switch the operator back to the Active tab so they can see it.
      setListTab('active');
    }
  };

  const handleOpenPurge = () => {
    if (!sel) return;
    setPurgeOpen(true);
  };

  const handlePurgeConfirmed = async () => {
    if (!sel) return;
    const result = await hardDeleteBrand(sel.id);
    if (result) {
      // Selection is now stale; let the auto-select effect pick a new row.
      setSelectedId(null);
      loadBrandStatsIncludingDeleted().catch(() => {});
    }
  };

  const handleManageMembers = (brandId: string) => {
    setSelectedId(brandId);
    setTabId('members.tsx');
    if (isCompact) setShowDetail(true);
  };

  const handleRename = async (newName: string): Promise<boolean> => {
    if (!sel) return false;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === sel.name) return false;
    const ok = await renameBrand(sel.id, trimmed);
    if (ok) Toast.show({ type: 'success', text1: 'Brand renamed', text2: trimmed });
    return ok;
  };

  // Phone — single pane.
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
          onRename={handleRename}
          onSoftDelete={() => setDeleteBrandOpen(true)}
          onRestore={handleRestore}
          onPurge={handleOpenPurge}
          onDeleteProfile={(u) => setDeleteProfileTarget(u)}
          superAdminUserId={currentUser?.id || ''}
        />
        <InviteAdminDrawer
          visible={inviteDrawerOpen}
          brandId={sel.id}
          brandName={sel.name}
          onClose={() => setInviteDrawerOpen(false)}
          onInvited={refreshAfterInvite}
        />
        {/* Modals — rendered here so they overlay the phone single-pane view. */}
        <TypeToConfirmModal
          visible={deleteBrandOpen}
          title={`Delete "${sel.name}"`}
          description={`Marks this brand as soft-deleted. It will disappear from the active picker but remains restorable for ${GRACE_DAYS} days. After ${GRACE_DAYS} days the Purge button becomes eligible for irreversible cascade.`}
          requiredText={sel.name}
          destructiveLabel="DELETE BRAND"
          destructiveTone="danger"
          onConfirm={handleSoftDelete}
          onClose={() => setDeleteBrandOpen(false)}
        />
        <CascadePreviewModal
          visible={purgeOpen}
          brandId={sel.id}
          brandName={sel.name}
          onClose={() => setPurgeOpen(false)}
          onPurgeConfirmed={handlePurgeConfirmed}
          onManageMembers={handleManageMembers}
        />
        {deleteProfileTarget ? (
          <DeleteProfileModal
            target={deleteProfileTarget}
            onClose={() => setDeleteProfileTarget(null)}
          />
        ) : null}
      </>
    );
  }

  if (isCompact) {
    return (
      <>
        <ListPane
          activeBrands={activeBrands}
          trashBrands={trashBrands}
          listTab={listTab}
          setListTab={setListTab}
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
        activeBrands={activeBrands}
        trashBrands={trashBrands}
        listTab={listTab}
        setListTab={setListTab}
        loadingStats={loadingStats}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id)}
        onNew={() => setNewDrawerOpen(true)}
      />

      <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {visibleBrands.length === 0
                ? listTab === 'trash' ? 'no brands in trash' : 'no brands yet'
                : 'select a brand'}
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
            onRename={handleRename}
            onSoftDelete={() => setDeleteBrandOpen(true)}
            onRestore={handleRestore}
            onPurge={handleOpenPurge}
            onDeleteProfile={(u) => setDeleteProfileTarget(u)}
            superAdminUserId={currentUser?.id || ''}
          />
        )}
      </View>

      <BrandFormDrawer visible={newDrawerOpen} onClose={() => setNewDrawerOpen(false)} />
      {sel ? (
        <>
          <InviteAdminDrawer
            visible={inviteDrawerOpen}
            brandId={sel.id}
            brandName={sel.name}
            onClose={() => setInviteDrawerOpen(false)}
            onInvited={refreshAfterInvite}
          />
          <TypeToConfirmModal
            visible={deleteBrandOpen}
            title={`Delete "${sel.name}"`}
            description={`Marks this brand as soft-deleted. It will disappear from the active picker but remains restorable for ${GRACE_DAYS} days. After ${GRACE_DAYS} days the Purge button becomes eligible for irreversible cascade.`}
            requiredText={sel.name}
            destructiveLabel="DELETE BRAND"
            destructiveTone="danger"
            onConfirm={handleSoftDelete}
            onClose={() => setDeleteBrandOpen(false)}
          />
          <CascadePreviewModal
            visible={purgeOpen}
            brandId={sel.id}
            brandName={sel.name}
            onClose={() => setPurgeOpen(false)}
            onPurgeConfirmed={handlePurgeConfirmed}
            onManageMembers={handleManageMembers}
          />
        </>
      ) : null}
      {deleteProfileTarget ? (
        <DeleteProfileModal
          target={deleteProfileTarget}
          onClose={() => setDeleteProfileTarget(null)}
        />
      ) : null}
    </>
  );
}

// ─── List pane ──────────────────────────────────────────────────────
function ListPane({
  activeBrands, trashBrands, listTab, setListTab, loadingStats, selectedId, onSelect, onNew,
}: {
  activeBrands: BrandStats[];
  trashBrands: BrandStats[];
  listTab: ListTab;
  setListTab: (t: ListTab) => void;
  loadingStats: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const C = useCmdColors();
  const T = useT();
  const isCompact = useIsCompact();
  const visible = listTab === 'active' ? activeBrands : trashBrands;
  return (
    <View
      style={{
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
        <Text style={[Type.h2, { color: C.fg }]}>{T('section.brands.title')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {visible.length} {visible.length === 1 ? 'brand' : 'brands'}
          </Text>
          {listTab === 'active' ? (
            <TouchableOpacity
              onPress={onNew}
              style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
              accessibilityRole="button"
              accessibilityLabel="New brand"
            >
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accentFg }}>+ NEW BRAND</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
      {/* Spec 012c — Active / Trash sub-tabs. */}
      <TabStrip
        tabs={[
          { id: 'active', label: `Active (${activeBrands.length})` },
          { id: 'trash', label: `Trash (${trashBrands.length})` },
        ]}
        activeId={listTab}
        onChange={(id) => setListTab(id as ListTab)}
        fillEvenly
      />
      {loadingStats ? (
        <View style={{ padding: 22 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>loading…</Text>
        </View>
      ) : visible.length === 0 ? (
        <View style={{ padding: 22 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            {listTab === 'trash'
              ? 'no soft-deleted brands'
              : 'no brands yet — click "+ NEW BRAND" to create one'}
          </Text>
        </View>
      ) : (
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={visible}
          keyExtractor={(b) => b.id}
          renderItem={({ item: b }) => {
            const isSel = b.id === selectedId;
            const isTrash = !!b.deletedAt;
            const days = daysSinceDeleted(b.deletedAt);
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
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text
                    style={{
                      fontFamily: sans(600),
                      fontSize: 13,
                      color: isTrash ? C.fg3 : C.fg,
                      textDecorationLine: isTrash ? 'line-through' : 'none',
                      flexShrink: 1,
                    }}
                    numberOfLines={1}
                  >
                    {b.name}
                  </Text>
                  {isTrash ? <StatusPill status="out" label="DELETED" /> : null}
                </View>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {b.storeCount} {b.storeCount === 1 ? 'store' : 'stores'} · {b.memberCount} {b.memberCount === 1 ? 'admin' : 'admins'} · {b.catalogIngredientCount} {b.catalogIngredientCount === 1 ? 'ingredient' : 'ingredients'}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                  {shortId(b.id)} · {isTrash && days !== null
                    ? `deleted ${days}d ago`
                    : `created ${fmtDate(b.createdAt)}`}
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
  sel, selStores, tabId, setTabId, admins, loadingAdmins,
  onInvite, onBack, onRename, onSoftDelete, onRestore, onPurge,
  onDeleteProfile, superAdminUserId,
}: {
  sel: BrandStats;
  selStores: ReturnType<typeof useStore.getState>['stores'];
  tabId: string;
  setTabId: (id: string) => void;
  admins: User[];
  loadingAdmins: boolean;
  onInvite: () => void;
  onBack?: () => void;
  onRename: (newName: string) => Promise<boolean>;
  onSoftDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onDeleteProfile: (u: User) => void;
  superAdminUserId: string;
}) {
  const C = useCmdColors();
  const isTrash = !!sel.deletedAt;
  const days = daysSinceDeleted(sel.deletedAt);
  const purgeEligible = isTrash && days !== null && days >= GRACE_DAYS;
  const restoreEligible = isTrash && days !== null && days < GRACE_DAYS;

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
            <StatusPill status={isTrash ? 'out' : 'ok'} label={isTrash ? 'DELETED' : 'ACTIVE'} />
            {isTrash && days !== null ? (
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                · soft-deleted {days}d ago
              </Text>
            ) : null}
          </View>
          {/* Inline rename — click name to edit. */}
          <InlineRename
            key={sel.id}
            initialName={sel.name}
            onSave={onRename}
          />
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            tenant · {sel.storeCount} stores · {sel.memberCount} admins · {sel.catalogIngredientCount} ingredients · created {fmtDate(sel.createdAt)}
          </Text>
          {/* Action row — Delete / Restore / Purge. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            {!isTrash ? (
              <DangerOutlineButton label="DELETE BRAND" onPress={onSoftDelete} />
            ) : (
              <>
                <RestoreButton
                  onPress={onRestore}
                  enabled={restoreEligible}
                  daysSince={days ?? 0}
                />
                <PurgeButton
                  onPress={onPurge}
                  enabled={purgeEligible}
                  daysSince={days ?? 0}
                />
              </>
            )}
          </View>
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
          </>
        ) : tabId === 'members.tsx' ? (
          <MembersTab
            admins={admins}
            loading={loadingAdmins}
            onInvite={onInvite}
            onDeleteProfile={onDeleteProfile}
            superAdminUserId={superAdminUserId}
          />
        ) : tabId === 'stores.tsx' ? (
          <StoresTab stores={selStores} brandId={sel.id} brandName={sel.name} />
        ) : null}
      </ScrollView>
    </View>
  );
}

// ─── Inline rename in detail header ─────────────────────────────────
function InlineRename({
  initialName,
  onSave,
}: {
  initialName: string;
  onSave: (newName: string) => Promise<boolean>;
}) {
  const C = useCmdColors();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(initialName);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    setDraft(initialName);
    setEditing(false);
  }, [initialName]);

  const commit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === initialName) {
      setEditing(false);
      setDraft(initialName);
      return;
    }
    setSubmitting(true);
    const ok = await onSave(trimmed);
    setSubmitting(false);
    if (ok) {
      setEditing(false);
    } else {
      // Revert on failure (notifyBackendError already toasted).
      setDraft(initialName);
      setEditing(false);
    }
  };

  if (!editing) {
    return (
      <TouchableOpacity
        onPress={() => setEditing(true)}
        accessibilityRole="button"
        accessibilityLabel={`Rename ${initialName}`}
        activeOpacity={0.7}
      >
        <Text style={[Type.h1, { color: C.fg }]}>{initialName}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      autoFocus
      editable={!submitting}
      placeholderTextColor={C.fg3}
      onKeyPress={(e: any) => {
        if (Platform.OS === 'web' && e?.nativeEvent?.key === 'Escape') {
          setDraft(initialName);
          setEditing(false);
        }
      }}
      style={{
        fontFamily: sans(700),
        fontSize: 22,
        color: C.fg,
        backgroundColor: C.panel2,
        borderWidth: 1,
        borderColor: C.borderStrong,
        borderRadius: CmdRadius.sm,
        paddingHorizontal: 8,
        paddingVertical: 6,
        // Cleanup SF #7 — narrower than `as any` for the RNW outline ext.
        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as Record<string, unknown>) : {}),
      }}
    />
  );
}

function DangerOutlineButton({ label, onPress }: { label: string; onPress: () => void }) {
  const C = useCmdColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: CmdRadius.sm,
        borderWidth: 1,
        borderColor: C.danger,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger }}>{label}</Text>
    </TouchableOpacity>
  );
}

function RestoreButton({
  onPress, enabled, daysSince,
}: { onPress: () => void; enabled: boolean; daysSince: number }) {
  const C = useCmdColors();
  const tooltip = enabled
    ? `Restore (${GRACE_DAYS - daysSince}d remaining)`
    : `Restore window expired (${daysSince}d since soft-delete)`;
  return (
    <TouchableOpacity
      onPress={enabled ? onPress : undefined}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={tooltip}
      accessibilityState={{ disabled: !enabled }}
      // @ts-ignore web-only `title` for native tooltip
      title={tooltip}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: CmdRadius.sm,
        borderWidth: 1,
        borderColor: enabled ? C.accent : C.border,
        opacity: enabled ? 1 : 0.55,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 11, color: enabled ? C.accent : C.fg3 }}>
        {enabled ? `RESTORE (${GRACE_DAYS - daysSince}d left)` : 'RESTORE EXPIRED'}
      </Text>
    </TouchableOpacity>
  );
}

function PurgeButton({
  onPress, enabled, daysSince,
}: { onPress: () => void; enabled: boolean; daysSince: number }) {
  const C = useCmdColors();
  const remaining = GRACE_DAYS - daysSince;
  const tooltip = enabled
    ? 'Open the cascade preview'
    : `Purge eligible in ${remaining} day${remaining === 1 ? '' : 's'}`;
  return (
    <TouchableOpacity
      onPress={enabled ? onPress : undefined}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={tooltip}
      accessibilityState={{ disabled: !enabled }}
      // @ts-ignore web-only `title` for native tooltip
      title={tooltip}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: CmdRadius.sm,
        backgroundColor: enabled ? C.danger : C.panel2,
        opacity: enabled ? 1 : 0.7,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 11, color: enabled ? C.accentFg : C.fg3 }}>
        {enabled ? 'PURGE NOW' : `PURGE IN ${remaining}D`}
      </Text>
    </TouchableOpacity>
  );
}

// ─── members.tsx ────────────────────────────────────────────────────
function MembersTab({
  admins, loading, onInvite, onDeleteProfile, superAdminUserId,
}: {
  admins: User[];
  loading: boolean;
  onInvite: () => void;
  onDeleteProfile: (u: User) => void;
  superAdminUserId: string;
}) {
  const C = useCmdColors();
  const T = useT();
  const demoteProfileToUser = useStore((s) => s.demoteProfileToUser);

  const handleDemote = (u: User) => {
    confirmAction(
      'Demote to user?',
      `Demote ${u.name || u.email} (${u.role}) to user? They will lose admin access to this brand. You can re-promote later via "+ INVITE ADMIN".`,
      async () => {
        await demoteProfileToUser(u.id);
      },
    );
  };

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
          {admins.map((u, i) => {
            // Spec 012c §8.7 — self-protection: super-admin cannot
            // demote / delete their own profile from this UI.
            const isSelf = !!superAdminUserId && u.id === superAdminUserId;
            // Pending invitations are synthetic User rows with id
            // `invitation:<uuid>` — neither demote nor delete apply
            // (no underlying profiles row to mutate).
            const isPending = u.status !== 'active' || u.id.startsWith('invitation:');
            // Cleanup SF #3 — `user`-role rows ALSO block H5 pre-flight
            // (`hard_delete_brand` raises if any profile has brand_id =
            // target, regardless of role). Without surfacing Demote/Delete
            // for `user` rows, the operator must drop to SQL to clear
            // them — exactly the workflow Q-A's strict REJECT was meant
            // to avoid. (Demote on a `user` row is a no-op for role but
            // still clears brand_id, which is what unblocks the purge.)
            const canActOn =
              !isSelf &&
              !isPending &&
              (u.role === 'admin' || u.role === 'master' || u.role === 'user');
            return (
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
                  flexWrap: 'wrap',
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
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accentFg }}>{u.initials}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
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
                    label={userStatusLabel(u.status, T)}
                  />
                </View>
                {canActOn ? (
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <TouchableOpacity
                      onPress={() => handleDemote(u)}
                      accessibilityRole="button"
                      accessibilityLabel={`Demote ${u.name} to user`}
                      style={{
                        paddingVertical: 5,
                        paddingHorizontal: 9,
                        borderRadius: CmdRadius.sm,
                        borderWidth: 1,
                        borderColor: C.borderStrong,
                      }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>
                        DEMOTE
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onDeleteProfile(u)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete profile ${u.name}`}
                      style={{
                        paddingVertical: 5,
                        paddingHorizontal: 9,
                        borderRadius: CmdRadius.sm,
                        borderWidth: 1,
                        borderColor: C.danger,
                      }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.danger }}>
                        DELETE
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : isSelf ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                    (you)
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Delete-profile modal (Q-ARCH-1) ────────────────────────────────
function DeleteProfileModal({
  target, onClose,
}: {
  target: User;
  onClose: () => void;
}) {
  const deleteProfile = useStore((s) => s.deleteProfile);
  return (
    <TypeToConfirmModal
      visible
      title={`Delete profile "${target.name || target.email}"`}
      description={`Permanently deletes ${target.name || target.email} (${target.email || 'no email'}). Removes both the profile row AND the auth.users row. The human user will no longer be able to log in. This cannot be undone.`}
      requiredText={target.name || target.email || ''}
      destructiveLabel="DELETE PROFILE"
      destructiveTone="danger"
      onConfirm={async () => {
        const ok = await deleteProfile(target.id);
        if (ok) onClose();
      }}
      onClose={onClose}
    />
  );
}

// ─── stores.tsx ─────────────────────────────────────────────────────
function StoresTab({
  stores,
  brandId,
  brandName,
}: {
  stores: ReturnType<typeof useStore.getState>['stores'];
  brandId: string;
  brandName: string;
}) {
  const C = useCmdColors();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[Type.h2, { color: C.fg }]}>Stores</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={() => setDrawerOpen(true)}
          style={{
            paddingVertical: 4,
            paddingHorizontal: 10,
            backgroundColor: C.accent,
            borderRadius: CmdRadius.sm,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>+ NEW STORE</Text>
        </TouchableOpacity>
      </View>
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
            Click "+ NEW STORE" above to add the first store under this brand.
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
      <StoreFormDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        brandId={brandId}
        brandName={brandName}
      />
    </View>
  );
}
