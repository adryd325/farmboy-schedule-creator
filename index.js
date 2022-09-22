import fs from "fs";
import os from "os";
import fetch from "node-fetch";
import moment from "moment-timezone";

const RUN_DATE = Date.now();

const commonHeaders = {
  "User-Agent":
    "farmboy-schedule-creator/1.0.0, https://github.com/adryd325/farmboy-schedule-creator",
  "x-client-info":
    "farmboy-schedule-creator/1.0.0, https://github.com/adryd325/farmboy-schedule-creator",
  "Accept-Language": "en-US,en;q=0.5",
  "Content-Type": "text/plain;charset=UTF-8",
  apiKey: process.env.FB_API_KEY,
};

// Check we have all the environment variables we need
function checkEnv() {
  const missing = [];
  for (let i of ["FB_API_HOST", "FB_API_KEY", "FB_PASSWORD", "FB_USERNAME"]) {
    if (process.env[i] === undefined) {
      missing.push(i);
    }
  }
  if (missing.length > 1) {
    console.log(
      "Missing the following environment variables: ",
      missing.join(", ")
    );
    process.exit(1);
  }
}

async function login() {
  const loginResponse = await fetch(
    `https://${process.env.FB_API_HOST}/auth/v1/token?grant_type=password`,
    {
      headers: {
        ...commonHeaders,
        authorization: `Bearer ${process.env.FB_API_KEY}`,
      },
      body: JSON.stringify({
        email: process.env.FB_USERNAME,
        password: process.env.FB_PASSWORD,
      }),
      method: "POST",
    }
  ).then((response) => response.json());
  return loginResponse.access_token;
}

async function loadStorage() {
  try {
    const scheduleDataText = await fs.promises.readFile("./scheduleData.json");
    // TODO: Normalize data before returning (remove unused fields etc.)
    return JSON.parse(scheduleDataText);
  } catch (e) {
    console.log("Failed to read or parse data storage");
    return {
      shifts: []
    };
  }
}

async function getSchedule(token) {
  return await fetch(
    `https://${process.env.FB_API_HOST}/rest/v1/schedules?select=startTime,endTime,role,store,department,workDate,id,duration,status,updated_at&order=startTime.asc.nullslast`,
    {
      headers: {
        ...commonHeaders,
        authorization: `Bearer ${token}`,
      },
    }
  ).then((response) => response.json());
}

function normalizeSchedule(schedule) {
  return schedule
    .filter((shift) => {
      // Only use non-cancelled shifts
      return shift.status !== 2;
    })
    .map((shift) => {
      // Normalize
      return {
        startTime: moment
          .tz(shift.startTime, "America/Toronto")
          .utc()
          .toDate()
          .getTime(),
        endTime: moment
          .tz(shift.endTime, "America/Toronto")
          .utc()
          .toDate()
          .getTime(),
        updatedTime: moment
          .tz(shift.updated_at, "America/Toronto")
          .utc()
          .toDate()
          .getTime(),
        store: shift.store,
        department: shift.department,
        role: shift.role,
        paidHours: shift.duration,
        status: shift.status,
      };
    })
    .filter((shift) => {
      // Rely on storage for shifts before Date.now()
      // Times in UTC
      return RUN_DATE < shift.startTime;
    });
}

async function writeStorage(storage) {
  await fs.promises.writeFile("./scheduleData.json", JSON.stringify(storage))
}

function icsDate(int) {
  return (new Date(int)).toISOString().replace(/[\-:]/g, "").replace(/\.\d{3}/, "")
}

function formatIcs(storage) {
  // ICS Header
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
PRODID:-//IDK//IDK//EN
X-WR-CALNAME:Farm Boy Schedule
X-APPLE-CALENDAR-COLOR:#FF2968
REFRESH-INTERVAL;VALUE=DURATION:PT4H
X-PUBLISHED-TTL:PT4H\n`;

  for (let i in storage.shifts) {
    const shift = storage.shifts[i]
    ics += `BEGIN:VEVENT
DTSTART:${icsDate(shift.startTime)}
DTEND:${icsDate(shift.endTime)}
SUMMARY:Farm Boy (${(shift.endTime-shift.startTime)/3600000} hour shift)${shift.status===1?" Updated":""}
LOCATION:Location: ${shift.store}. Department: ${shift.department}. Role: ${shift.role}
DESCRIPTION:Paid hours: ${shift.paidHours}
SEQUENCE:${i+1}
STATUS:CONFIRMED
END:VEVENT\n`
  }
  ics += "END:VCALENDAR\n"

  return ics
}

async function writeIcs(ics) {
  fs.promises.writeFile("./schedule.ics", ics)
}

checkEnv();
const storage = await loadStorage();

let schedule;
try {
  // Hack to not have to repeat code
  if (!storage.token) {
    throw new Error();
  }
  console.log("Attempting to use cached token");
  schedule = await getSchedule(storage.token);
} catch (e) {
  console.log("Logging in");
  storage.token = await login();
  schedule = await getSchedule(storage.token);
}

// Clean up data for our own use
schedule = normalizeSchedule(schedule);

console.log(schedule)

// Update our saved schedule
storage.shifts = [...storage.shifts.filter((shift) => {return RUN_DATE >= shift.startTime}), ...schedule];
writeStorage(storage)

// Write our ics file
writeIcs(formatIcs(storage))