import React from 'react';
import { View, Text, TouchableOpacity, Platform, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { ResponsiveSheet } from './ResponsiveSheet';
import { TypeToConfirmModal } from './TypeToConfirmModal';
import { useStore } from '../../store/useStore';
import { useIsPhone } from '../../theme/breakpoints';
import type { BrandCascadePreview } from '../../lib/db';

// Spec 012c §8.6 — two-step purge UI.
//   Step 1: cascade preview (per-table counts + blocking-profiles red
//           error block per Q-USER-A).
//   Step 2: type-the-name confirmation (re-uses TypeToConfirmModal).
//
// On Step 1 → Step 2 transition the preview re-fetches server-side to
// guard against the "new admin invited mid-flow" race. If new orphans
// appear, we flip back to Step 1 with the updated red block.

interface CascadePreviewModalProps {
  visible: boolean;
  brandId: string;
  brandName: string;
  onClose: () => void;
  /** Fires after the user successfully completes the type-to-confirm
   *  step. The parent invokes useStore.hardDeleteBrand here. */
  onPurgeConfirmed: () => void | Promise<void>;
  /** Open the BrandsSection members tab on this brand so the operator
   *  can clear orphan profiles without leaving the Cmd UI. */
  onManageMembers: (brandId: string) => void;
}

type Step = 1 | 2;

export const CascadePreviewModal: React.FC<CascadePreviewModalProps> = ({
  visible,
  brandId,
  brandName,
  onClose,
  onPurgeConfirmed,
  onManageMembers,
}) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const previewBrandCascade = useStore((s) => s.previewBrandCascade);

  const [step, setStep] = React.useState<Step>(1);
  const [preview, setPreview] = React.useState<BrandCascadePreview | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [transitioning, setTransitioning] = React.useState(false);
  const [purging, setPurging] = React.useState(false);

  // Initial fetch on open.
  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setStep(1);
    setPreview(null);
    setLoading(true);
    previewBrandCascade(brandId)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [visible, brandId, previewBrandCascade]);

  const blockingCount = preview?.blockingProfiles?.length ?? 0;
  const counts = preview?.counts ?? {};
  const totalRows = React.useMemo(
    () => Object.values(counts).reduce((acc, n) => acc + (Number(n) || 0), 0),
    [counts],
  );

  // Esc closes Step 1; the inner TypeToConfirmModal owns Esc on Step 2.
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible || step !== 1) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, step, onClose]);

  const continueToStep2 = async () => {
    if (loading || transitioning || blockingCount > 0) return;
    setTransitioning(true);
    try {
      // Re-run the preview to catch any orphan profiles that may have
      // appeared between Step 1 and clicking Continue (§11 risk #4 —
      // "new admin invited mid-flow" mitigation).
      const fresh = await previewBrandCascade(brandId);
      setPreview(fresh);
      if ((fresh?.blockingProfiles?.length ?? 0) > 0) {
        // Stay on Step 1; new orphans appeared.
        return;
      }
      setStep(2);
    } finally {
      setTransitioning(false);
    }
  };

  const handlePurgeConfirmed = async () => {
    if (purging) return;
    setPurging(true);
    try {
      await onPurgeConfirmed();
      // Parent should close the modal after the action completes; if it
      // does not, fall through to onClose so the user isn't stuck.
      onClose();
    } finally {
      setPurging(false);
    }
  };

  if (!visible) return null;

  // Step 2 hand-off — TypeToConfirmModal renders its own ResponsiveSheet.
  // We hide Step 1's sheet beneath it by returning the inner modal only.
  if (step === 2) {
    return (
      <TypeToConfirmModal
        visible
        title={`Purge ${brandName}`}
        description={`Permanently erases this brand and every store, recipe, vendor, ingredient, EOD submission, and audit-log row attached to it. This cannot be undone.${
          totalRows > 0 ? ` (${totalRows.toLocaleString()} rows total)` : ''
        }`}
        requiredText={brandName}
        destructiveLabel="PURGE PERMANENTLY"
        destructiveTone="danger"
        onConfirm={handlePurgeConfirmed}
        onClose={() => {
          // Step 2 cancel returns to Step 1 (operator can reconsider
          // without losing the cascade preview).
          setStep(1);
        }}
      />
    );
  }

  const header = (
    <View
      style={{
        height: 44,
        paddingHorizontal: 18,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.panel,
      }}
    >
      <View
        style={{
          paddingHorizontal: 7,
          paddingVertical: 2,
          borderRadius: 3,
          backgroundColor: C.dangerBg,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.danger }}>
          PURGE PREVIEW
        </Text>
      </View>
      <Text
        style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }}
        numberOfLines={1}
      >
        {brandName}
      </Text>
      <View style={{ flex: 1 }} />
      {isPhone ? (
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={6}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
        </TouchableOpacity>
      ) : (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
      )}
    </View>
  );

  const continueDisabled = loading || transitioning || blockingCount > 0;

  const footer = (
    <View
      style={{
        minHeight: 54,
        paddingHorizontal: 18,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.panel,
        flexWrap: 'wrap',
      }}
    >
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
        {loading
          ? 'loading preview…'
          : blockingCount > 0
            ? `${blockingCount} blocking profile${blockingCount === 1 ? '' : 's'} — clear before continuing`
            : `${totalRows.toLocaleString()} rows will be erased`}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.border,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>← CANCEL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={continueToStep2}
        disabled={continueDisabled}
        accessibilityRole="button"
        accessibilityLabel="Continue to confirmation"
        accessibilityState={{ disabled: continueDisabled }}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: continueDisabled ? C.panel2 : C.danger,
          opacity: continueDisabled ? 0.6 : 1,
        }}
      >
        <Text
          style={{
            fontFamily: mono(700),
            fontSize: 11,
            color: continueDisabled ? C.fg3 : C.accentFg,
          }}
        >
          {transitioning ? 'CHECKING…' : 'CONTINUE →'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={640}
      tabletSheetHeight={0.85}
      presentation={{ desktop: 'center-modal' }}
      header={header}
      footer={footer}
      accessibilityLabel={`Purge ${brandName} cascade preview`}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 22, gap: 14 }}
      >
        {loading ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            loading cascade preview…
          </Text>
        ) : !preview ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.danger }}>
            failed to load preview — try again
          </Text>
        ) : (
          <>
            {blockingCount > 0 ? (
              <View
                style={{
                  backgroundColor: C.dangerBg,
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: C.danger,
                  padding: 12,
                  gap: 8,
                }}
              >
                <Text
                  style={{
                    fontFamily: mono(700),
                    fontSize: 10,
                    color: C.danger,
                    letterSpacing: 0.5,
                    textTransform: 'uppercase',
                  }}
                >
                  Cannot purge: {blockingCount} profile{blockingCount === 1 ? '' : 's'} still belong to this brand
                </Text>
                <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2, lineHeight: 18 }}>
                  Reassign or delete each profile via the members tab before continuing.
                  Use Demote to user (lighter) or Delete profile (irreversible).
                </Text>
                <View
                  style={{
                    backgroundColor: C.panel,
                    borderRadius: CmdRadius.sm,
                    borderWidth: 1,
                    borderColor: C.border,
                    overflow: 'hidden',
                  }}
                >
                  {preview.blockingProfiles.map((p, i) => (
                    <View
                      key={p.profileId}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderTopWidth: i === 0 ? 0 : 1,
                        borderTopColor: C.border,
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg }} numberOfLines={1}>
                          {p.name || '—'}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>
                          {p.email || '(no email)'} · {p.role}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => {
                          onManageMembers(brandId);
                          onClose();
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Manage members for ${brandName}`}
                        style={{
                          paddingVertical: 5,
                          paddingHorizontal: 9,
                          borderRadius: CmdRadius.sm,
                          borderWidth: 1,
                          borderColor: C.borderStrong,
                        }}
                      >
                        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg2 }}>
                          MANAGE
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              <View
                style={{
                  backgroundColor: C.okBg,
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: C.border,
                  padding: 12,
                  gap: 4,
                }}
              >
                <Text
                  style={{
                    fontFamily: mono(700),
                    fontSize: 10,
                    color: C.ok,
                    letterSpacing: 0.5,
                    textTransform: 'uppercase',
                  }}
                >
                  Ready to purge
                </Text>
                <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2, lineHeight: 18 }}>
                  No profiles attached to this brand. Continue to type-the-name confirmation.
                </Text>
              </View>
            )}

            {/* Per-table row counts. */}
            <View style={{ gap: 6 }}>
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 9.5,
                  color: C.fg3,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                Cascade preview
              </Text>
              <View
                style={{
                  backgroundColor: C.panel,
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: C.border,
                  overflow: 'hidden',
                }}
              >
                {Object.keys(counts).length === 0 ? (
                  <View style={{ padding: 12 }}>
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                      no per-table counts returned
                    </Text>
                  </View>
                ) : (
                  Object.keys(counts).sort().map((tbl, i) => {
                    const n = Number(counts[tbl]) || 0;
                    return (
                      <View
                        key={tbl}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: C.border,
                        }}
                      >
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, flex: 1 }}>
                          {tbl}
                        </Text>
                        <Text style={{ fontFamily: mono(700), fontSize: 11, color: n > 0 ? C.fg : C.fg3 }}>
                          {n.toLocaleString()}
                        </Text>
                      </View>
                    );
                  })
                )}
                {Object.keys(counts).length > 0 ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderTopWidth: 1,
                      borderTopColor: C.borderStrong,
                      backgroundColor: C.panel2,
                    }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg, flex: 1 }}>
                      total
                    </Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg }}>
                      {totalRows.toLocaleString()}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>

            {/* Brand metadata. */}
            <View
              style={{
                backgroundColor: C.panel2,
                borderRadius: CmdRadius.sm,
                borderWidth: 1,
                borderColor: C.border,
                padding: 12,
                gap: 4,
              }}
            >
              <Text
                style={{
                  fontFamily: mono(700),
                  fontSize: 9.5,
                  color: C.fg3,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                Brand
              </Text>
              <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2 }}>
                id · {preview.brandId}
              </Text>
              <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2 }}>
                soft-deleted · {preview.deletedAt ? preview.deletedAt.slice(0, 19) + 'Z' : '—'}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </ResponsiveSheet>
  );
};
