export interface Command<T = unknown> {
  id: string;
  type: string;
  payload: T;
  timestamp: Date;
  correlationId?: string;
  organizationId?: string;
  userId?: string;
  priority?: number;
}

export interface JobDefinition<T = unknown> {
  name: string;
  data: T;
  opts?: {
    delay?: number;
    attempts?: number;
    backoff?: { type: 'exponential' | 'fixed'; delay: number };
    priority?: number;
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
    jobId?: string;
  };
}

export interface RecurringJobDefinition<T = unknown> extends JobDefinition<T> {
  pattern?: string;
  every?: number;
}
