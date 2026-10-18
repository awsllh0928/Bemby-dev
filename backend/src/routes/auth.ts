import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import svgCaptcha from 'svg-captcha';
import { setSetting } from '../db/repos/settings';
import { bumpTokenEpoch, getJwtSecret, requireAuth, sessionClaims } from '../middleware/auth';
import { consumeCaptcha, issueCaptcha } from '../auth/captchaStore';
import {
  legacyHashPassword,
  hashPassword,
  isArgon2Hash,
  verifyPassword,
  timingSafeCompare as credTimingSafeCompare,
  constantTimeStringEquals,
  getStoredCredentials as getStoredCreds,
} from '../auth/credentials';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Handing out challenges is cheap but not free, and an unbounded stream of them is the one
// way to make the store churn. Generous enough that a person reloading a stuck captcha
// never meets it.
const captchaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many captcha requests. Please try again later.' },
});

// Both of these check the current password, so they are password guessing by another name
// and belong behind the same kind of brake as the login form.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const router = Router();

// Hash at module load so the env var is never compared as plaintext during a request
const ADMIN_PASSWORD_HASH_FALLBACK: string | null = (() => {
  const p = process.env.ADMIN_PASSWORD;
  return p ? legacyHashPassword(p) : null;
})();

router.get('/captcha', captchaLimiter, (_req, res) => {
  const captcha = svgCaptcha.create({ noise: 2, color: true, size: 5, ignoreChars: '0oO1lI' });
  // The answer stays in the process (see auth/captchaStore); what goes out is an opaque id.
  // The field keeps its old name so an already-loaded page keeps working.
  res.json({ svg: captcha.data, captchaToken: issueCaptcha(captcha.text) });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, captchaToken, captchaAnswer } = req.body as {
    username?: string;
    password?: string;
    captchaToken?: string;
    captchaAnswer?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  if (!captchaToken || !captchaAnswer) {
    res.status(400).json({ error: 'Captcha is required' });
    return;
  }

  // One challenge, one attempt: consuming it here means a solved captcha cannot be replayed
  // across a run of password guesses.
  if (!consumeCaptcha(captchaToken, captchaAnswer)) {
    res.status(400).json({ error: 'Incorrect or expired captcha, please refresh' });
    return;
  }

  const stored = await getStoredCreds();
  let valid: boolean;

  // The username is compared without short-circuiting and the password is always hashed,
  // so a wrong username costs the same as a wrong password and neither can be told apart
  // from the outside.
  const usernameOk = constantTimeStringEquals(username, stored.username);

  if (stored.passwordHash) {
    valid = (await verifyPassword(password, stored.passwordHash)) && usernameOk;
  } else {
    if (!ADMIN_PASSWORD_HASH_FALLBACK) {
      res.status(500).json({ error: 'ADMIN_PASSWORD env var is not set' });
      return;
    }
    valid = credTimingSafeCompare(legacyHashPassword(password), ADMIN_PASSWORD_HASH_FALLBACK) && usernameOk;
  }

  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Silently upgrade legacy HMAC hash to argon2id on next successful login
  if (stored.passwordHash && !isArgon2Hash(stored.passwordHash)) {
    const upgraded = await hashPassword(password);
    await setSetting('admin_password_hash', upgraded);
  }

  const defaultPwd = process.env.ADMIN_DEFAULT_PASSWORD ?? 'changeme';
  const requirePasswordChange = password === defaultPwd;
  const token = jwt.sign(await sessionClaims(username, requirePasswordChange), getJwtSecret(), {
    expiresIn: '7d',
  });
  res.json(requirePasswordChange ? { token, requirePasswordChange: true } : { token });
});

// POST /revoke-sessions -- sign out everywhere. A token cannot be withdrawn once signed, so
// this moves the epoch every token is checked against, retiring the lot; the caller is then
// handed a new one so the tab it was invoked from stays logged in.
router.post('/revoke-sessions', requireAuth, async (_req, res) => {
  try {
    await bumpTokenEpoch();
    const { username } = await getStoredCreds();
    res.json({
      message: 'All other sessions signed out',
      token: jwt.sign(await sessionClaims(username), getJwtSecret(), { expiresIn: '7d' }),
    });
  } catch (e) {
    console.error('[auth] revoke-sessions failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/credentials', requireAuth, credentialLimiter, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body as {
    username?: string;
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword) {
    res.status(400).json({ error: 'Current password is required' });
    return;
  }

  const stored = await getStoredCreds();
  const validCurrent = stored.passwordHash
    ? await verifyPassword(currentPassword, stored.passwordHash)
    : ADMIN_PASSWORD_HASH_FALLBACK
      ? credTimingSafeCompare(legacyHashPassword(currentPassword), ADMIN_PASSWORD_HASH_FALLBACK)
      : false;

  if (!validCurrent) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  if (!username && !newPassword) {
    res.status(400).json({ error: 'Provide a new username or password' });
    return;
  }

  const newHash = newPassword ? await hashPassword(newPassword) : null;
  // Written sequentially rather than in a transaction: Mongo transactions need a replica set,
  // and this is two independent key writes where a partial failure leaves the credentials in
  // one of two states the operator can simply retry. SQLite rolled both back together.
  if (username) await setSetting('admin_username', username);
  if (newHash) await setSetting('admin_password_hash', newHash);

  // Changing the credentials has to mean something to a token already out there, or a
  // stolen one survives the change for the rest of its seven days. Moving the epoch first
  // retires every existing token; the fresh one below is signed under the new epoch, which
  // also clears any requirePasswordChange claim.
  await bumpTokenEpoch();
  const newUsername = username || stored.username;
  const freshToken = jwt.sign(await sessionClaims(newUsername), getJwtSecret(), {
    expiresIn: '7d',
  });
  res.json({ message: 'Credentials updated', token: freshToken });
});

export default router;
