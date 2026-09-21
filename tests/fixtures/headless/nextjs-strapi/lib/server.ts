import "server-only";
// SAFE: server-only credential, never shipped to client
const secret = process.env.STRAPI_API_TOKEN;
export async function fetchCms(){ return fetch('https://cms.example/rest', {headers:{Authorization: 'Bearer ' + secret}}); }
