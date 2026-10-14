export const where = (): string => new Error('tiny').stack!.split('\n')[1];
