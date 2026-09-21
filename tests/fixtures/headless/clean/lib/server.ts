import "server-only";
const secret = process.env.SERVER_ONLY_DB_PASSWORD;
export async function load(){ return fetch('https://api.example', {headers:{Authorization: 'Bearer ' + secret}}); }
