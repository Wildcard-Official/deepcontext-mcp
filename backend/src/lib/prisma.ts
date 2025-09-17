import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare global {
  // Allow global var declarations
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  if (!global.__prisma) {
    global.__prisma = new PrismaClient();
  }
  prisma = global.__prisma;
}

export default prisma;
