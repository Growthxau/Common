const nodemailer = require('nodemailer');
const { getPublicOrigin } = require('./origin');

function smtpConfiguration() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM?.trim();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || Boolean(user) !== Boolean(pass) || !from) {
    return null;
  }
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    ...(user ? { auth: { user, pass } } : {}),
    from,
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

async function sendAccountLink({ request, email, name, token, type }) {
  const configuration = smtpConfiguration();
  if (!configuration) return false;

  const origin = getPublicOrigin(request);
  const url = new URL('/', origin);
  url.searchParams.set(type === 'verify_email' ? 'verify' : 'reset', token);
  const verification = type === 'verify_email';
  const subject = verification ? 'Verify your G-Squad email' : 'Reset your G-Squad password';
  const action = verification ? 'verify your email address' : 'reset your password';
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const link = url.toString();
  const transporter = nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    auth: configuration.auth,
  });
  await transporter.sendMail({
    from: configuration.from,
    to: email,
    subject,
    text: `${greeting}\n\nUse this link to ${action}: ${link}\n\nThis link expires in one hour. If you did not request this, you can ignore this message.`,
    html: `<p>${escapeHtml(greeting)}</p><p>Use this link to ${escapeHtml(action)}:</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>This link expires in one hour. If you did not request this, you can ignore this message.</p>`,
  });
  return true;
}

module.exports = { sendAccountLink, smtpConfiguration };
