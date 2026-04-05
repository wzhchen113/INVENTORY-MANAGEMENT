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

/** Invite a new user (admin only — creates Supabase Auth user + profile) */
export async function inviteUser(
  email: string,
  name: string,
  role: 'admin' | 'user',
  storeIds: string[]
): Promise<{ error: string | null }> {
  // Supabase Admin API — requires service role key (only call from server/edge function)
  // For simplicity in this app, we use signUp with a temporary password
  const tempPassword = Math.random().toString(36).slice(-10) + 'Aa1!';

  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { name, role },
  });

  if (error) return { error: error.message };

  if (data.user) {
    await supabase.from('profiles').upsert({
      id: data.user.id,
      name,
      role,
      initials: name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(),
      status: 'pending',
    });

    for (const storeId of storeIds) {
      await supabase.from('user_stores').insert({ user_id: data.user.id, store_id: storeId });
    }
  }

  return { error: null };
}
