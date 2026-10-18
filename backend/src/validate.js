const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/;
// XSS protection: reject markup characters outright rather than storing escaped text
const NAME_RE = /^[\p{L}\p{M}' .-]+$/u;

function isObject(body) {
  return body && typeof body === 'object' && !Array.isArray(body);
}

function validateEmail(email, errors) {
  if (typeof email !== 'string' || email.length > 100 || !EMAIL_RE.test(email.trim())) {
    errors.push('email must be a valid email address');
  }
}

function validatePassword(password, errors) {
  // bcrypt only uses the first 72 bytes, so cap there rather than silently truncating
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
    errors.push('password must be 8-72 characters');
  }
}

function validateRegistration(body) {
  if (!isObject(body)) return ['Request body must be a JSON object'];
  const errors = [];
  const { name, email, password } = body;
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) {
    errors.push('name must be a string of 2-50 characters');
  } else if (!NAME_RE.test(name.trim())) {
    errors.push('name may only contain letters, spaces, apostrophes, periods and hyphens');
  }
  validateEmail(email, errors);
  validatePassword(password, errors);
  return errors;
}

function validateLogin(body) {
  if (!isObject(body)) return ['Request body must be a JSON object'];
  const errors = [];
  if (typeof body.email !== 'string' || !body.email.trim()) errors.push('email is required');
  if (typeof body.password !== 'string' || !body.password) errors.push('password is required');
  return errors;
}

// partial=true for PATCH: fields are optional but at least one must be present
function validateNote(body, { partial = false } = {}) {
  if (!isObject(body)) return ['Request body must be a JSON object'];
  const errors = [];
  const { title, body: text } = body;
  if (title !== undefined || !partial) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 100) {
      errors.push('title must be a string of 1-100 characters');
    }
  }
  if (text !== undefined && (typeof text !== 'string' || text.length > 5000)) {
    errors.push('body must be a string of at most 5000 characters');
  }
  if (partial && title === undefined && text === undefined) {
    errors.push('provide title and/or body');
  }
  return errors;
}

module.exports = { validateRegistration, validateLogin, validateNote };
