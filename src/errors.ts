export function friendlyErrorMessage(error: Error, traceId: string): string {
  const msg = error.message;

  // BigQuery errors
  if (msg.includes('NOT_FOUND'))
    return `I couldn't find one of the tables I need. The data model may have changed recently. (trace: ${traceId})`;
  if (msg.includes('ACCESS_DENIED') || msg.includes('FORBIDDEN'))
    return `I don't have access to query this data from this channel. (trace: ${traceId})`;
  if (msg.includes('DEADLINE_EXCEEDED') || msg.includes('timeout'))
    return `This query took too long. Try asking for a smaller time range or fewer dimensions. (trace: ${traceId})`;

  // Gemini errors
  if (msg.includes('RESOURCE_EXHAUSTED'))
    return `I'm experiencing high demand — please try again in a moment. (trace: ${traceId})`;
  if (msg.includes('SAFETY'))
    return `I wasn't able to process that question. Try rephrasing it. (trace: ${traceId})`;

  // Default — always include traceId so the data team can investigate
  return `Something went wrong. I've logged the details for the data team. (trace: ${traceId})`;
}
