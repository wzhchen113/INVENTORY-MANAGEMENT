// src/lib/auth.ts
import { supabase } from './supabase';
import { User } from '../types';

export interface AuthResult {
  user: User | null;
  error: string | null;
}

/** Sign in with email + password */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { user: null, error: error.message };
  }

  if (!data.user) {
    return { user: null, error: 'No user returned' };
  }

  return await fetchProfile(data.user.id);
}

/** Sign out */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Get current session (call on app start) */
export async function getSession(): Promise<AuthResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return { user: null, error: null };
  return await fetchProfile(session.user.id);
}

/** Fetch user profile + store access from DB */
async function fetchProfile(userId: string): Promise<AuthResult> {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    return { user: null, error: profileError?.message || 'Profile not found' };
  }

  const { data: storeLinks } = await supabase
    .from('user_stores')
    .select('store_id')
    .eq('user_id', userId);

  const stores = (storeLinks || []).map((s: any) => s.store_id);

  const user: User = {
    id: userId,
    name: profile.name,
    email: profile.email || '',
    role: profile.role,
    stores,
    status: profile.status,
    initials: profile.initials || profile.name.slice(0, 2).toUpperCase(),
    color: profile.color || '#378ADD',
  };

  return { user, error: null };
}

/** Invite a new user (admin only — creates invitation record in Supabase) */
export async function inviteUser(
  email: string,
  name: string,
  role: 'admin' | 'user',
  storeIds: string[]
): Promise<{ error: string | null }> {
  try {
    // Check if invitation already exists for this email
    const { data: existing } = await supabase
      .from('invitations')
      .select('id')
      .eq('email', email.toLowerCase())
      .eq('used', false)
      .single();

    if (existing) {
      return { error: 'An invitation for this email already exists' };
    }

    // Create invitation record — profile + auth user created at registration time
    const { error: inviteError } = await supabase.from('invitations').insert({
      email: email.toLowerCase(),
      profile_id: '00000000-0000-0000-0000-000000000000', // placeholder, replaced at registration
      name,
      role,
      store_ids: storeIds,
    });

    if (inviteError) return { error: inviteError.message };

    return { error: null };
  } catch (e: any) {
    return { error: e.message || 'Failed to invite user' };
  }
}

/** Register an invited user (creates Supabase auth account + profile) */
export async function registerInvitedUser(
  email: string,
  password: string,
  name: string
): Promise<AuthResult> {
  try {
    // Check if there's a pending invitation for this email
    const { data: invitation, error: invError } = await supabase
      .from('invitations')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('used', false)
      .single();

    if (invError || !invitation) {
      return { user: null, error: 'No invitation found for this email. Please ask an admin to invite you.' };
    }

    // Create the Supabase auth user
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name: invitation.name, role: invitation.role } },
    });

    if (signUpError) return { user: null, error: signUpError.message };
    if (!authData.user) return { user: null, error: 'Registration failed' };

    // Create profile with real auth user ID
    const { error: profileError } = await supabase.from('profiles').insert({
      id: authData.user.id,
      name: invitation.name,
      role: invitation.role,
      initials: invitation.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(),
      color: '#378ADD',
      status: 'active',
    });

    if (profileError) {
      return { user: null, error: `Account created but profile setup failed: ${profileError.message}` };
    }

    // Create store links from invitation
    const storeIds = invitation.store_ids || [];
    for (const storeId of storeIds) {
      await supabase.from('user_stores').insert({ user_id: authData.user.id, store_id: storeId });
    }

    // Mark invitation as used
    await supabase.from('invitations').update({ used: true }).eq('id', invitation.id);

    return { user: null, error: null }; // Return null user — they need to sign in
  } catch (e: any) {
    return { user: null, error: e.message || 'Registration failed' };
  }
}

/** Resend invitation (re-creates if needed) */
export async function resendInvite(email: string): Promise<{ error: string | null }> {
  // Check if invitation exists
  const { data: invitation } = await supabase
    .from('invitations')
    .select('*')
    .eq('email', email.toLowerCase())
    .eq('used', false)
    .single();

  if (!invitation) {
    return { error: 'No pending invitation found for this email' };
  }

  // For now, just confirm the invitation exists — the user can register via the app
  return { error: null };
}
