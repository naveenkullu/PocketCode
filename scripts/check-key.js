console.log('LEN:', process.env.TOKEN_ENCRYPTION_KEY.length);
console.log('CHARS:', [...process.env.TOKEN_ENCRYPTION_KEY].map(c => c.charCodeAt(0)));