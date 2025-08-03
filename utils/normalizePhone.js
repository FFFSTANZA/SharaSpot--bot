// utils/normalizePhone.js
function normalizePhone(phone) {

  if (!phone) return '';
  // 1. Remove all non-digit characters
  const digits = String(phone).replace(/\D/g, '');
  
  // 2. Handle Indian numbers (91 prefix)
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2); // Remove 91 prefix
  }
  
  // 3. Handle numbers with 0 prefix
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1); // Remove leading 0
  }
  
  // 4. For 10-digit numbers, return as-is
  if (digits.length === 10) {
    return digits;
  }
  
  // 5. Fallback - return last 10 digits
  return digits.slice(-10);
}

module.exports = { normalizePhone };  // Named export