function paymentBelongsToSession(payment, session) {
  if (!payment || !session) return false;
  const paymentId = String(payment.id || payment.payment_id || '');
  const externalId = String(
    payment.external_reference
      || payment.externalReference
      || payment.metadata?.external_id
      || ''
  );
  return paymentId === String(session.checkout_id || '')
    && externalId === String(session.external_id || '');
}

module.exports = { paymentBelongsToSession };
