'use client';
// VULN: client-side bundle embeds a privileged CMS token
export const CMS_ADMIN_TOKEN = process.env.NEXT_PUBLIC_WP_ADMIN_TOKEN;
export const CMS_ENDPOINT = 'https://wordpress.example/graphql';
export default function Page(){ return <div data-token={CMS_ADMIN_TOKEN}>leak</div>; }
