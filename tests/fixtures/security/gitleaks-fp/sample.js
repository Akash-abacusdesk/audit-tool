// These are INTENTIONALLY fake/example values - must NOT raise real secret findings (FP-handling validation)
const EXAMPLE_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'; // AWS documentation example key
const placeholder = 'password'; // common false positive
const testToken = 'test-api-key-12345'; // non-secret test fixture
module.exports = { EXAMPLE_AWS_KEY, placeholder, testToken };