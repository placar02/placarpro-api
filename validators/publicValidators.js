const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const cleanText = (value, max = 255) => String(value ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);
const validEmail = (value) => {
  const normalized = cleanText(value, 255).toLowerCase();
  return EMAIL.test(normalized) && normalized.length <= 255 ? normalized : null;
};
const strongPassword = (value) => typeof value === 'string'
  && value.length >= 10 && value.length <= 128
  && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
const positiveId = (value) => /^\d{1,18}$/.test(String(value || '')) && Number(value) > 0;

function validateAuth(kind) {
  return (req, res, next) => {
    const email = validEmail(req.body?.email);
    if ((kind === 'login' || kind === 'register' || kind === 'forgot') && !email) {
      return res.status(422).json({ error: 'Dados invalidos.' });
    }
    if (email) req.body.email = email;
    if (kind === 'register') {
      const nome = cleanText(req.body?.nome, 120);
      if (nome.length < 2 || !strongPassword(req.body?.senha)) {
        return res.status(422).json({ error: 'Nome ou senha invalidos. Use 10 caracteres com maiuscula, minuscula e numero.' });
      }
      if (req.body?.acceptedPrivacy !== true || req.body?.acceptedTerms !== true) {
        return res.status(422).json({ error: 'E necessario aceitar os Termos de Uso e a Politica de Privacidade.' });
      }
      req.body.nome = nome;
    }
    if (kind === 'login' && (typeof req.body?.senha !== 'string' || req.body.senha.length > 128)) {
      return res.status(422).json({ error: 'Dados invalidos.' });
    }
    return next();
  };
}

function validateIdParam(name = 'id') {
  return (req, res, next) => positiveId(req.params[name]) ? next() : res.status(422).json({ error: 'Identificador invalido.' });
}

module.exports = { cleanText, positiveId, strongPassword, validEmail, validateAuth, validateIdParam };
