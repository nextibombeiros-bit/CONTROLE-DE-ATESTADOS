import { createClient } from "@supabase/supabase-js";

const fallbackSupabaseUrl = "https://wzimpnedfceadlgolrqw.supabase.co";
const fallbackSupabaseAnonKey = "sb_publishable__mbE04zCaANBZSs6ut0Row_spv272W6";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || fallbackSupabaseUrl;
const supabaseAnonKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || fallbackSupabaseAnonKey;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;
