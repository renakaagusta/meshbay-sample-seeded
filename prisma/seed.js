const { PrismaClient } = require("@prisma/client");

const database = new PrismaClient();

const referencePlans = [
  { code: "starter", name: "Starter", priceCents: 0 },
  { code: "growth", name: "Growth", priceCents: 2900 },
  { code: "scale", name: "Scale", priceCents: 9900 },
];

const demoAdmin = {
  email: "admin@example.com",
  name: "Demo Admin",
  role: "admin",
};

async function seed() {
  if (process.env.FAIL_SEED === "1") {
    throw new Error("FAIL_SEED=1: refusing to seed (failure simulation)");
  }

  for (const plan of referencePlans) {
    await database.plan.upsert({
      where: { code: plan.code },
      create: plan,
      update: { name: plan.name, priceCents: plan.priceCents },
    });
  }

  await database.user.upsert({
    where: { email: demoAdmin.email },
    create: demoAdmin,
    update: { name: demoAdmin.name, role: demoAdmin.role },
  });

  await database.seedState.upsert({
    where: { id: 1 },
    create: { id: 1, runCount: 1, lastRunAt: new Date() },
    update: { runCount: { increment: 1 }, lastRunAt: new Date() },
  });

  console.log(`seeded ${referencePlans.length} plans and 1 demo admin`);
}

seed()
  .catch((seedError) => {
    console.error("seed failed:", seedError.message);
    process.exitCode = 1;
  })
  .finally(() => database.$disconnect());
