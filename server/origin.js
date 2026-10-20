function getPublicOrigin(request) {
  const configuredOrigin = process.env.APP_ORIGIN
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL;

  if (!configuredOrigin) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('APP_ORIGIN must be configured outside Vercel before sending account links.');
    }
    return `${request.protocol}://${request.get('host')}`;
  }

  const origin = configuredOrigin.includes('://') ? configuredOrigin : `https://${configuredOrigin}`;
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/'
      || parsedOrigin.search || parsedOrigin.hash
      || (process.env.NODE_ENV === 'production' && parsedOrigin.protocol !== 'https:')) {
    throw new Error('APP_ORIGIN must be a plain HTTPS origin in production.');
  }
  return parsedOrigin.origin;
}

function getRequestOrigin(request) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  const protocol = process.env.VERCEL ? 'https' : request.protocol;
  return `${protocol}://${request.get('host')}`;
}

module.exports = { getPublicOrigin, getRequestOrigin };
