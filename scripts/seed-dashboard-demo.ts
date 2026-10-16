import dataSource from '../ormconfig';
import { ConsciousnessLevel } from '../src/constants/consciousness-level';
import { Gender } from '../src/constants/gender';
import { PatientRecordDailyStatsEntity } from '../src/modules/patient-record/patient-record-daily-stats.entity';
import { PatientRecordEntity } from '../src/modules/patient-record/patient-record.entity';

const DEMO_NAME_PREFIX = 'DEMO_DASHBOARD_';

interface IDailySeed {
  date: string;
  total: number;
  yellow: number;
  red: number;
}

function toVietnamYmd(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function vietnamDayInstant(ymd: string, hour: number, minute: number, second = 0): Date {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return new Date(`${ymd}T${hh}:${mm}:${ss}.000+07:00`);
}

function buildLatestSevenDaysSeed(): IDailySeed[] {
  const today = new Date();
  const totals = [16, 21, 19, 24, 27, 23, 30];
  const yellows = [4, 6, 5, 7, 8, 6, 9];
  const reds = [1, 2, 1, 2, 3, 2, 3];

  const days: IDailySeed[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const index = 6 - i;
    days.push({
      date: toVietnamYmd(d),
      total: totals[index],
      yellow: yellows[index],
      red: reds[index],
    });
  }

  return days;
}

function buildScores(total: number, yellow: number, red: number): number[] {
  const scores: number[] = [];
  for (let i = 0; i < red; i++) {
    scores.push(7);
  }
  for (let i = 0; i < yellow; i++) {
    scores.push(i % 2 === 0 ? 5 : 6);
  }
  while (scores.length < total) {
    scores.push(scores.length % 5);
  }
  return scores;
}

async function seedDemoDashboardData(): Promise<void> {
  await dataSource.initialize();
  const manager = dataSource.manager;
  const patientRepo = manager.getRepository(PatientRecordEntity);
  const dailyRepo = manager.getRepository(PatientRecordDailyStatsEntity);
  const seed = buildLatestSevenDaysSeed();
  const dates = seed.map((d) => d.date);

  const shouldClearOnly = process.argv.includes('--clear');

  await dataSource.transaction(async (tx) => {
    const txPatientRepo = tx.getRepository(PatientRecordEntity);
    const txDailyRepo = tx.getRepository(PatientRecordDailyStatsEntity);

    await txPatientRepo
      .createQueryBuilder()
      .delete()
      .where('full_name LIKE :prefix', { prefix: `${DEMO_NAME_PREFIX}%` })
      .execute();

    await txDailyRepo
      .createQueryBuilder()
      .delete()
      .where('stats_date IN (:...dates)', { dates })
      .execute();

    if (shouldClearOnly) {
      return;
    }

    for (const day of seed) {
      const scores = buildScores(day.total, day.yellow, day.red);
      const records = scores.map((score, index) =>
        txPatientRepo.create({
          fullName: `${DEMO_NAME_PREFIX}${day.date}_${index + 1}`,
          dateOfBirth: new Date('1995-05-10'),
          gender: Gender.MALE,
          respiratoryRate: 16,
          spo2: 98,
          bloodPressure: '118/75',
          heartRate: 72,
          temperature: 36.7,
          consciousness: ConsciousnessLevel.ALERT,
          triageScore: score,
          createdByUserId: null,
          createdAt: vietnamDayInstant(day.date, 8 + (index % 10), index % 60),
          updatedAt: vietnamDayInstant(day.date, 8 + (index % 10), index % 60),
        }),
      );

      await txPatientRepo.save(records);
      await txDailyRepo.save({
        statsDate: day.date,
        totalCount: day.total,
        yellowCount: day.yellow,
        redCount: day.red,
      });
    }
  });

  const totalDemoRecords = await patientRepo
    .createQueryBuilder('pr')
    .where('pr.fullName LIKE :prefix', { prefix: `${DEMO_NAME_PREFIX}%` })
    .getCount();

  const totalDailyRows = await dailyRepo
    .createQueryBuilder('stats')
    .where('stats.statsDate IN (:...dates)', { dates })
    .getCount();

  if (shouldClearOnly) {
    console.log('Dashboard demo data cleared.');
    return;
  }

  console.log('Dashboard demo seed completed.');
  console.log(`Inserted demo patient records: ${totalDemoRecords}`);
  console.log(`Inserted/updated daily stats rows: ${totalDailyRows}`);
  console.log('To remove demo records later, run this script with --clear.');
}

seedDemoDashboardData()
  .catch((error) => {
    console.error('Failed to seed dashboard demo data:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });
