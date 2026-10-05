export function isHumanVerificationResponse({ status, json, text } = {}) {
  if (Number(status) >= 500 || Number(status) < 300) return false;
  const message = [json?.error_code, json?.error, json?.error_description, json?.message, json?.msg, text]
    .filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /human[_ -]?verification[_ -]?required|anti.?bot|captcha|turnstile|cf-chl|challenge-platform|just a moment|checking your browser|security (?:check|challenge)|robot check|human.{0,30}(?:check|verif|required)|verif(?:ication)? requise/.test(message);
}
