import { registerProcessor, registerSchedule } from '../workers';
import { handleInbound, sweepInbound } from '@/modules/whatsapp/agent';
import { WHATSAPP_CHAT_JOB } from '@/modules/whatsapp/inbound';

/** One job per inbound WhatsApp message: the assistant answers it as the linked person. Two at a time; the pipeline serialises messages from one phone. */
registerProcessor({
  queue: 'ai',
  jobName: WHATSAPP_CHAT_JOB,
  concurrency: 2,
  processor: async (job) => handleInbound(String((job.data as { inboundId?: string }).inboundId ?? ''), Number((job.data as { n?: number }).n ?? 0)),
});

/** Messages whose job never ran get it again; claims a dead run left behind are recorded as failed. */
registerSchedule({ queue: 'maintenance', jobName: 'whatsapp-inbound-sweep', pattern: '*/10 * * * *' });
registerProcessor({ queue: 'maintenance', jobName: 'whatsapp-inbound-sweep', processor: async () => sweepInbound() });
