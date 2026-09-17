import type { ProfileDetails, ProfileUpdatePayload } from "@chartanalyzer/shared";
import { supabaseAdmin } from "../lib/supabase.js";

interface ProfileRow {
  full_name: string | null;
  phone_number: string | null;
  profession: string | null;
  location: string | null;
  email: string;
  credit_balance: number;
  created_at: string;
}

export async function getProfileDetails(profileId: string): Promise<ProfileDetails | null> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("full_name, phone_number, profession, location, email, credit_balance, created_at")
    .eq("id", profileId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) return null;

  const row: ProfileRow = data;
  return {
    fullName: row.full_name,
    phoneNumber: row.phone_number,
    profession: row.profession,
    location: row.location,
    email: row.email,
    creditBalance: row.credit_balance,
    memberSince: row.created_at,
  };
}

/**
 * None of fullName/phoneNumber/profession/location are in
 * protect_profile_columns()'s guarded list (see the init migration and
 * 20260902130200_profile_contact_details.sql), so a plain update through the
 * service-role client is enough — no RPC needed, unlike email/credit_balance.
 *
 * Only the keys present in `updates` are written — a field the caller didn't
 * touch is left as-is rather than overwritten with an implicit null.
 */
export async function updateProfileDetails(
  profileId: string,
  updates: ProfileUpdatePayload,
): Promise<void> {
  const row: Record<string, string> = {};
  if (updates.fullName !== undefined) row["full_name"] = updates.fullName;
  if (updates.phoneNumber !== undefined) row["phone_number"] = updates.phoneNumber;
  if (updates.profession !== undefined) row["profession"] = updates.profession;
  if (updates.location !== undefined) row["location"] = updates.location;

  if (Object.keys(row).length === 0) return;

  const { error } = await supabaseAdmin.from("profiles").update(row).eq("id", profileId);
  if (error) {
    throw error;
  }
}
