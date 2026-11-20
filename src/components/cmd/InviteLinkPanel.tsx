import React from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { buildInviteLink, formatInviteExpiry, inviteLinkBase } from '../../lib/inviteLink';

/** Spec 198 — the one-time code returned by create_invitation, plus the link
 *  built from it. Held only in component state; cleared when the drawer
 *  re-opens. */
export interface IssuedInvite {
  email: string;
  code: string;
  link: string | null;
  /** Review CR-2 — create_invitation's expires_at (ISO timestamptz). */
  expiresAt: string;
}

/** Spec 198 §6 — `<origin>/?register=true&invite=<code>`, or null when there is
 *  no known base (native with no EXPO_PUBLIC_WEB_RECOVERY_URL). Shared by both
 *  invite drawers. */
export function buildIssuedInviteLink(code: string): string | null {
  const base = inviteLinkBase(
    Platform.OS,
    typeof window !== 'undefined' ? window.location?.origin : null,
    process.env.EXPO_PUBLIC_WEB_RECOVERY_URL,
  );
  return base ? buildInviteLink(base, code) : null;
}

interface Props {
  /** The invited email (for the "send this link to …" copy). */
  email: string;
  /** The one-time plaintext invite code (32 hex). Shown only now. */
  code: string;
  /** The full register link, or null when no base URL is known (native with
   *  no EXPO_PUBLIC_WEB_RECOVERY_URL) — then the bare code is shown instead. */
  link: string | null;
  /** The invitation's server-issued expiry (create_invitation's expires_at,
   *  ISO timestamptz). Rendered as a local date/time; omitted if unparseable. */
  expiresAt: string | null;
  /** Close the drawer. */
  onDone: () => void;
}

// Spec 198 §6 (AD-10) — the "invitation issued" body shared by
// InviteUserDrawer and InviteAdminDrawer. The code is stored hashed server-side,
// so this is the ONLY time the inviter can see it; the copy says so and points
// at re-invite (B8) as the recovery for a lost link.
//
// Copy button is web only (navigator.clipboard); on native the link is
// selectable text. No new dependency.
export const InviteLinkPanel: React.FC<Props> = ({ email, code, link, expiresAt, onDone }) => {
  const C = useCmdColors();
  const value = link ?? code;
  const noun = link ? 'link' : 'code';
  // Review CR-2 — the real expiry from the server, not a second copy of its
  // 48-hour constant.
  const expiresLabel = formatInviteExpiry(expiresAt);

  const handleCopy = async () => {
    try {
      const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (!clip || typeof clip.writeText !== 'function') throw new Error('clipboard unavailable');
      await clip.writeText(value);
      Toast.show({ type: 'success', text1: 'Link copied' });
    } catch {
      Toast.show({ type: 'error', text1: 'Copy failed. Select the link and copy it.' });
    }
  };

  return (
    <View style={{ gap: 14 }}>
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
          {link ? 'Invite link' : 'Invite code'}
        </Text>
        <View
          style={{
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.accent,
            borderRadius: CmdRadius.sm,
            paddingHorizontal: 10,
            paddingVertical: 9,
          }}
        >
          <Text
            testID="invite-link"
            selectable
            style={{ fontFamily: mono(400), fontSize: 12, color: C.fg }}
          >
            {value}
          </Text>
        </View>
        {Platform.OS === 'web' ? (
          <View style={{ flexDirection: 'row' }}>
            <TouchableOpacity
              testID="invite-link-copy"
              onPress={handleCopy}
              accessibilityRole="button"
              accessibilityLabel="Copy invite link"
              style={{
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderRadius: CmdRadius.sm,
                borderWidth: 1,
                borderColor: C.border,
                backgroundColor: C.panel2,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>COPY {noun.toUpperCase()}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <Text testID="invite-link-expiry" style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg }}>
        Send this {noun} to {email}. It works once
        {expiresLabel ? ` and expires ${expiresLabel}.` : '.'}
      </Text>
      {link ? null : (
        <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg2 }}>
          Ask them to open Register in the app and enter this code.
        </Text>
      )}
      <View
        style={{
          backgroundColor: C.warnBg,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.warn,
          padding: 10,
        }}
      >
        <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.warn }}>
          This {noun} is shown only now. If it is lost, invite the same email again: that makes a new {noun} and
          the old one stops working.
        </Text>
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <TouchableOpacity
          testID="invite-done"
          onPress={onDone}
          accessibilityRole="button"
          accessibilityLabel="Done"
          style={{
            paddingVertical: 6,
            paddingHorizontal: 14,
            borderRadius: CmdRadius.sm,
            backgroundColor: C.accent,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accentFg }}>DONE</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
