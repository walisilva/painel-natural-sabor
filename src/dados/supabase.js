/* Cliente Supabase. A chave publishable é pública por design: quem protege os dados é a RLS do banco. */
(function (FP) {
  "use strict";
  const URL = "https://qhqutekauzveehmfofxj.supabase.co";
  const CHAVE_PUBLICA = "sb_publishable_kz7VAeDkHyGAMj61CTOTdw_hUg604lG";
  FP.sb = window.supabase.createClient(URL, CHAVE_PUBLICA, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
})(window.FP = window.FP || {});
