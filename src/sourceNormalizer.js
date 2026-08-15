const GENERIC_TITLES = new Set([
  'bing',
  'calendar',
  'email',
  'file',
  'files',
  'mail',
  'microsoft 365',
  'microsoft teams',
  'office 365',
  'onedrive',
  'outlook',
  'owa',
  'people',
  'sharepoint',
  'source',
  'teams',
  'web',
]);

const TITLE_FIELDS = [
  'subject',
  'emailSubject',
  'messageSubject',
  'eventSubject',
  'meetingSubject',
  'title',
  'displayName',
  'name',
  'fileName',
  'documentName',
  'resourceName',
];

function cleanTitle(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*•\d.)]+\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+[-–—:]\s*$/, '')
    .trim();
}

function isGenericTitle(value) {
  const normalized = cleanTitle(value).toLowerCase().replace(/[.:]$/, '');
  return !normalized || GENERIC_TITLES.has(normalized);
}

function firstExplicitTitle(source) {
  for (const field of TITLE_FIELDS) {
    const value = source?.[field] ?? source?.metadata?.[field] ?? source?.resource?.[field];
    if (typeof value === 'string' && !isGenericTitle(value)) return cleanTitle(value);
  }
  return null;
}

function resourceTypeFrom(source, url) {
  const declared = [
    source?.resourceType,
    source?.entityType,
    source?.contentType,
    source?.providerDisplayName,
    source?.provider,
    source?.attributionSource,
    source?.['@odata.type'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const target = String(url || '').toLowerCase();
  const value = `${declared} ${target}`;

  if (/\b(mail|email|message|owa)\b|outlook\.office\.com\/mail/.test(value)) return 'email';
  if (/\b(calendar|meeting|event)\b|outlook\.office\.com\/calendar/.test(value)) return 'meeting';
  if (/\b(file|document|sharepoint|onedrive|driveitem)\b|sharepoint\.com|1drv\.ms/.test(value)) return 'file';
  if (/\b(teams|chat|channel)\b|teams\.microsoft\.com/.test(value)) return 'chat';
  if (/\b(person|people|profile|org chart)\b/.test(value)) return 'person';
  if (/\b(web|bing)\b/.test(value)) return 'web';
  return 'source';
}

function titleFromUrl(url, resourceType) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    for (const key of ['subject', 'title', 'name', 'filename', 'file']) {
      const value = parsed.searchParams.get(key);
      if (value && !isGenericTitle(value)) return cleanTitle(value);
    }
    if (resourceType === 'email' || resourceType === 'meeting' || resourceType === 'person') return null;
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    if (!last || isGenericTitle(last) || /^[A-Za-z0-9_-]{32,}$/.test(last)) return null;
    return cleanTitle(last) || null;
  } catch {
    return null;
  }
}

function citationPosition(answer, citationId, citationNumber) {
  const marker = /【\s*([^】]+?)\s*】|\[\^?(\d+(?:\s*,\s*\d+)*)\^?\]/g;
  for (const match of String(answer || '').matchAll(marker)) {
    const values = (match[1] || match[2] || '').split(',').map((value) => value.trim());
    if (
      values.includes(String(citationId)) ||
      values.some((value) => /^\d+$/.test(value) && Number(value) === citationNumber)
    ) {
      return match.index;
    }
  }
  return -1;
}

function contextTitle(answer, citationId, citationNumber) {
  const position = citationPosition(answer, citationId, citationNumber);
  if (position < 0) return null;
  const prefix = String(answer).slice(Math.max(0, position - 280), position);
  const candidates = [];
  const patterns = [
    /<([A-Za-z][^>]*)>([^<]{3,160})<\/[^>]+>/g,
    /\*\*([^*\n]{3,160})\*\*/g,
    /\[([^\]\n]{3,160})\]\(https?:\/\/[^)]+\)/g,
    /[“"]([^”"\n]{3,160})[”"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of prefix.matchAll(pattern)) {
      const value = cleanTitle(match[2] || match[1]);
      if (!isGenericTitle(value)) candidates.push({ index: match.index, value });
    }
  }
  if (candidates.length) return candidates.sort((left, right) => right.index - left.index)[0].value;

  const line = cleanTitle(prefix.slice(Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('|')) + 1));
  if (line.length >= 3 && line.length <= 140 && !isGenericTitle(line)) return line;
  return null;
}

function fallbackTitle(resourceType, index) {
  const labels = {
    email: 'Email',
    meeting: 'Meeting',
    file: 'File',
    chat: 'Teams conversation',
    person: 'Person',
    web: 'Web page',
    source: 'Source',
  };
  return `${labels[resourceType] || 'Source'} ${index}`;
}

function sourceFromValue(source, index, answer, citationId = String(index)) {
  const url = source?.targetLink || source?.seeMoreWebUrl || source?.url || source?.webUrl || null;
  const provider = source?.providerDisplayName || source?.provider || null;
  const resourceType = resourceTypeFrom(source, url);
  const inferredFromAnswer = contextTitle(answer, citationId, index);
  const inferredFromUrl = titleFromUrl(url, resourceType);
  const title =
    firstExplicitTitle(source) ||
    (!isGenericTitle(provider) ? cleanTitle(provider) : null) ||
    (resourceType === 'file' || resourceType === 'web' ? inferredFromUrl : inferredFromAnswer) ||
    inferredFromUrl ||
    inferredFromAnswer ||
    fallbackTitle(resourceType, index);

  return {
    id: String(citationId),
    title,
    url,
    type: source?.isCitedInResponse === false ? 'annotation' : (source?.attributionType || 'citation').toLowerCase(),
    provider,
    resourceType,
  };
}

export function referencesToSources(references, answer = '') {
  if (!references || typeof references !== 'object' || Array.isArray(references)) return [];
  let entries = Object.entries(references).filter(([key]) => key !== '@odata.type');
  if (!entries.length) return [];

  const citedEntries = entries.filter(([, value]) => value?.isCitedInResponse !== false);
  if (citedEntries.length) entries = citedEntries;
  else if (entries.every(([, value]) => value?.isCitedInResponse === false)) return [];

  if (entries.every(([key]) => /^\d+$/.test(key))) {
    entries.sort(([left], [right]) => Number(left) - Number(right));
  }

  return entries.map(([key, value], index) => sourceFromValue(value, index + 1, answer, key));
}

export function attributionsToSources(attributions, answer = '') {
  if (!Array.isArray(attributions)) return [];
  const ordered = [
    ...attributions.filter((item) => String(item?.attributionType || '').toLowerCase() !== 'annotation'),
    ...attributions.filter((item) => String(item?.attributionType || '').toLowerCase() === 'annotation'),
  ];
  return ordered.map((value, index) => sourceFromValue(value, index + 1, answer));
}

function collectCitationContainers(value, containers, seen, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10 || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectCitationContainers(item, containers, seen, depth + 1);
    return;
  }
  const entries = Object.entries(value).filter(([key]) => key !== '@odata.type');
  if (
    entries.length &&
    entries.every(
      ([, nested]) =>
        nested &&
        typeof nested === 'object' &&
        !Array.isArray(nested) &&
        ['targetLink', 'seeMoreWebUrl', 'url', 'webUrl'].some(
          (field) => typeof nested[field] === 'string'
        )
    )
  ) {
    containers.references.push(value);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'attributions' && Array.isArray(nested)) containers.attributions.push(nested);
    else if (normalizedKey === 'references' && nested && typeof nested === 'object') containers.references.push(nested);
    else collectCitationContainers(nested, containers, seen, depth + 1);
  }
}

export function sourcesFromPayload(payload, answer = '') {
  const containers = { references: [], attributions: [] };
  collectCitationContainers(payload, containers, new WeakSet());
  const sourceGroups = [
    ...containers.references.map((references) => referencesToSources(references, answer)),
    ...containers.attributions.map((attributions) => attributionsToSources(attributions, answer)),
  ];
  const sources = [];
  const seen = new Set();
  for (const source of sourceGroups.flat()) {
    const key = source.url || `${source.provider || ''}\n${source.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources;
}
