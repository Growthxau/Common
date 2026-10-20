export function detectDeviceType(input = {}) {
  const userAgent = input.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const maxTouchPoints = input.maxTouchPoints ?? (typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0);
  const width = input.innerWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  const ua = String(userAgent).toLowerCase();

  const isMobileUA = /iphone|ipod|android.*mobile|windows phone|mobile|mobi|blackberry|opera mini/i.test(ua);
  const isTabletUA = /ipad|android(?!.*mobile)|tablet|playbook|silk|kindle/i.test(ua);
  const isIPadOS = /macintosh/i.test(ua) && maxTouchPoints > 1;

  if (isTabletUA || isIPadOS || (width >= 768 && width <= 1280 && maxTouchPoints > 1)) {
    return 'tablet';
  }

  if (isMobileUA || (width > 0 && width <= 767 && maxTouchPoints > 1)) return 'mobile';

  return 'desktop';
}

export function isMobileOnlyDevice(input) {
  return detectDeviceType(input) === 'mobile';
}
