const ADMIN_NUMBERS = new Set([
    '9790294221',
    '6003160229'
]);

const normalizePhone = (phone) => {
    return phone.replace(/\D/g, '').slice(-10);
};

const verifyAdmin = (phone) => {
    return ADMIN_NUMBERS.has(normalizePhone(phone));
};

module.exports = {
    verifyAdmin,
    ADMIN_NUMBERS,
    normalizePhone
};