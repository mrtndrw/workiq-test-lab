(() => {
  const NAMED_ENTITIES = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };

  function decodeTextEntities(value) {
    let text = String(value == null ? '' : value);
    for (let pass = 0; pass < 3; pass++) {
      const decoded = text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal, hex, named) => {
        if (decimal) {
          const codePoint = Number(decimal);
          return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : match;
        }
        if (hex) {
          const codePoint = Number.parseInt(hex, 16);
          return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : match;
        }
        return NAMED_ENTITIES[named.toLowerCase()] ?? match;
      });
      if (decoded === text) break;
      text = decoded;
    }
    return text;
  }

  function parseJsonAt(text, start) {
    let index = start;
    while (/\s/.test(text[index] || '')) index += 1;
    const first = text[index];
    if (!['"', '{', '['].includes(first)) return null;

    if (first === '"') {
      let escaped = false;
      for (let cursor = index + 1; cursor < text.length; cursor++) {
        const char = text[cursor];
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          try {
            const decoded = JSON.parse(text.slice(index, cursor + 1));
            const value = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;
            return { value, end: cursor + 1 };
          } catch {
            return null;
          }
        }
      }
      return null;
    }

    const closing = first === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === first) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          try {
            return { value: JSON.parse(text.slice(index, cursor + 1)), end: cursor + 1 };
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  function taskCollection(value, depth = 0) {
    if (depth > 5 || value == null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      const taskLike = value.filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          (typeof item.title === 'string' || typeof item.name === 'string' || typeof item.subject === 'string')
      );
      if (taskLike.length) return taskLike;
      for (const item of value) {
        const nested = taskCollection(item, depth + 1);
        if (nested) return nested;
      }
      return null;
    }
    for (const key of ['tasks', 'items', 'value']) {
      const nested = taskCollection(value[key], depth + 1);
      if (nested) return nested;
    }
    for (const nestedValue of Object.values(value)) {
      const nested = taskCollection(nestedValue, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  function displayValue(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => item?.displayName || item?.name || item?.title || (typeof item === 'string' ? item : ''))
        .filter(Boolean)
        .join(', ');
    }
    return value.displayName || value.name || value.title || value.dateTime || value.content || '';
  }

  function formatPlannerPayload(payload) {
    const tasks = taskCollection(payload);
    if (!tasks?.length) {
      return `**Planner data**\n\n${JSON.stringify(payload, null, 2)}`;
    }

    const listTitle =
      payload?.title ||
      payload?.name ||
      payload?.displayName ||
      payload?.plan?.title ||
      payload?.plan?.name ||
      'Planner tasks';
    const lines = [`## ${listTitle}`];
    for (const [index, task] of tasks.entries()) {
      const title = task.title || task.name || task.subject || `Task ${index + 1}`;
      const details = [];
      const status =
        task.percentComplete != null
          ? `${task.percentComplete}% complete`
          : displayValue(task.status || task.state);
      const due = displayValue(task.dueDateTime || task.dueDate || task.due);
      const assignees = displayValue(task.assignees || task.assignedTo || task.owner);
      const priority = displayValue(task.priority);
      if (status) details.push(`Status: ${status}`);
      if (due) details.push(`Due: ${due}`);
      if (assignees) details.push(`Assigned to: ${assignees}`);
      if (priority) details.push(`Priority: ${priority}`);

      const done = Number(task.percentComplete) === 100 || /completed|done/i.test(status);
      lines.push(`- [${done ? 'x' : ' '}] **${title}**${details.length ? ` — ${details.join(' · ')}` : ''}`);

      const description = displayValue(task.description || task.notes || task.body);
      if (description) lines.push(`  ${description}`);
      const url = task.webUrl || task.url || task.link;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) lines.push(`  [Open task](${url})`);
    }
    return lines.join('\n');
  }

  function normalize(value) {
    let text = decodeTextEntities(value);
    text = text.replace(/<\/?m-planner\b[^>]*>/gi, '');

    const marker = /(?:planner\s+)?task\s+list\s+part\s*:\s*/gi;
    for (let pass = 0; pass < 5; pass++) {
      marker.lastIndex = 0;
      const match = marker.exec(text);
      if (!match) break;
      const parsed = parseJsonAt(text, match.index + match[0].length);
      if (!parsed) break;
      text =
        text.slice(0, match.index) +
        formatPlannerPayload(parsed.value) +
        text.slice(parsed.end);
    }
    return text.trim();
  }

  window.WorkIqAnswerFormatter = {
    decodeTextEntities,
    normalize,
  };
})();
