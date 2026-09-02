import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ID = 'rex-nursing-quiz';
const DATABASE_ID = '(default)';
const API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDTZqe69W7bOsKypP-dbI5IUllWpVkGUWs';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDir, '../assets/salary/approved-reports.json');
const PUBLIC_FIELDS = [
  'hospitalName', 'region', 'hospitalTier', 'isCivilService', 'tenureRange',
  'nurseLadder', 'unitType', 'baseSalary', 'paidMonths', 'eveningDiff',
  'annualEveningShiftCount', 'nightDiff', 'annualNightShiftCount',
  'yearEndBonus', 'otherFixedAnnualBonus', 'otherFixedAnnualBonusNote',
  'estimatedAnnualSalary', 'notes', 'source', 'createdAt', 'reviewedAt',
];

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

async function fetchApprovedReports() {
  const endpoint = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${encodeURIComponent(DATABASE_ID)}/documents:runQuery?key=${encodeURIComponent(API_KEY)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'salaryReports' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'status' },
            op: 'EQUAL',
            value: { stringValue: 'approved' },
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Firestore query failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows.filter(row => row.document).map((row) => {
    const document = row.document;
    const decoded = decodeFields(document.fields || {});
    const publicData = Object.fromEntries(
      PUBLIC_FIELDS.filter(field => decoded[field] !== undefined).map(field => [field, decoded[field]])
    );
    return {
      ...publicData,
      __id: document.name.split('/').at(-1),
    };
  });
}

const regionOrder = ['台北市','新北市','桃園市','台中市','台南市','高雄市','基隆市','新竹市','新竹縣','苗栗縣','彰化縣','南投縣','雲林縣','嘉義市','嘉義縣','屏東縣','宜蘭縣','花蓮縣','台東縣','澎湖縣','金門縣','連江縣'];
const reports = await fetchApprovedReports();
reports.sort((a, b) => {
  const regionDiff = regionOrder.indexOf(a.region) - regionOrder.indexOf(b.region);
  if (regionDiff) return regionDiff;
  const nameDiff = String(a.hospitalName || '').localeCompare(String(b.hospitalName || ''), 'zh-Hant');
  if (nameDiff) return nameDiff;
  return String(a.__id).localeCompare(String(b.__id));
});

const output = {
  schemaVersion: 1,
  source: 'Firestore salaryReports where status=approved',
  count: reports.length,
  reports,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`Wrote ${reports.length} approved salary reports to ${outputPath}`);
