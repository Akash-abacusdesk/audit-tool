import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// S6-D3 headless fixture generator. The crossstack unit test references this
// module to materialize the Next.js + CMS fixtures on a clean checkout
// (they are generated, not committed). Creates fixtures for the four
// headless stacks plus a clean control that must yield zero findings.

const base = join(process.cwd(), 'tests/fixtures/headless');

const cmsUrl = {
  'nextjs-wordpress': 'https://cms.example/wp-json/wp/v2/posts',
  'nextjs-payload': 'https://cms.example/payload/collections/posts',
  'nextjs-directus': 'https://cms.example/directus/items/posts',
  'nextjs-strapi': 'https://cms.example/strapi/api/posts',
};

const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz';

for (const [name, url] of Object.entries(cmsUrl)) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'page.tsx'),
    `'use client';\nimport { wp } from './wp';\nexport default function Page() {\n  const AKIAW2abcdefghijklmn = 'AKIAW2abcdefghijklmn';\n  return fetch('${url}?token=${secret}');\n}\n`,
    'utf8',
  );
  await writeFile(
    join(dir, '.env.local'),
    `NEXT_PUBLIC_SITE_URL=https://x.com\nNEXT_PUBLIC_STRIPE_SECRET=${secret}\n`,
    'utf8',
  );
}

const clean = join(base, 'clean');
await mkdir(clean, { recursive: true });
await writeFile(
  join(clean, 'benign.ts'),
  `const greeting = "hello";\nconst url = process.env.NEXT_PUBLIC_SITE_URL;\n`,
  'utf8',
);
