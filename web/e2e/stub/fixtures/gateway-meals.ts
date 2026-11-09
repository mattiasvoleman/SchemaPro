import type { MealClass, MealCountsView, MealDay, MealSettings, MealSitting, MealTotals } from "../../../lib/meal-counts";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { addDays, isoWeekday, TODAY } from "./calendar";
import { GROUPS } from "./world";

/**
 * Måltidskollen as the gateway answers it (src/meal-counts/): the portions of each lunch
 * sitting from the school's today, and the cut-off, the kitchen's address and the letter's
 * switch.
 *
 * Every weekday has two sittings: 7A and 7B eat 10:30-11:00 (7A has one pupil away for the
 * day, reported in time) and 8A 11:00-11:30 (a reported absence after the cut-off, and a
 * replacement lesson over lunch, so the activity mark is seen). Weekends have none, so both
 * the table of sittings and the day with none are drawn. The school has placed a pedagogisk
 * lunch for four staff in the first sitting, so the staff column has figures.
 */

const SETTINGS: MealSettings = { cutoffTime: "08:30", letterEnabled: true, kitchenEmail: "kok@skolan.example", lastLetterOn: addDays(TODAY, -1) };

const cls = (name: string, groupId: string, pupils: number, absentBefore: number, absentAfter: number, underActivity = false): MealClass => ({
  groupId,
  name,
  pupils,
  absentBefore,
  absentAfter,
  underActivity,
  portions: pupils - absentBefore,
});

const sum = (parts: readonly MealTotals[]): MealTotals => ({
  pupils: parts.reduce((total, part) => total + part.pupils, 0),
  absentBefore: parts.reduce((total, part) => total + part.absentBefore, 0),
  staff: parts.reduce((total, part) => total + part.staff, 0),
  portions: parts.reduce((total, part) => total + part.portions, 0),
  absentAfter: parts.reduce((total, part) => total + part.absentAfter, 0),
  underActivity: parts.reduce((total, part) => total + part.underActivity, 0),
});

function sitting(start: string, end: string, classes: MealClass[], staff: number): MealSitting {
  const pupils = classes.reduce((total, c) => total + c.pupils, 0);
  const absentBefore = classes.reduce((total, c) => total + c.absentBefore, 0);
  return {
    start,
    end,
    classes,
    pupils,
    absentBefore,
    staff,
    portions: pupils - absentBefore + staff,
    absentAfter: classes.reduce((total, c) => total + c.absentAfter, 0),
    underActivity: classes.filter((c) => c.underActivity).reduce((total, c) => total + c.pupils, 0),
  };
}

function dayOf(date: string): MealDay {
  const weekday = isoWeekday(date);
  const sittings =
    weekday > 5
      ? []
      : [
          sitting("10:30", "11:00", [cls("7A", GROUPS.g7A.id, 24, 1, 0), cls("7B", GROUPS.g7B.id, 25, 0, 0)], 4),
          sitting("11:00", "11:30", [cls("8A", GROUPS.g8A.id, 22, 0, 2, true)], 0),
        ];
  return { date, weekday, sittings, totals: sum(sittings) };
}

function counts(context: GatewayContext): MealCountsView | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  if (context.person.persona !== "admin") return new Reply(403, { message: "Forbidden." });
  const from = context.query.get("from") ?? TODAY;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return new Reply(400, { message: "from: ett datum ÅÅÅÅ-MM-DD." });
  if (from < TODAY) return new Reply(400, { code: "MEAL_COUNTS_PAST", message: "Antalen gäller dagar från och med i dag." });
  const asked = Number(context.query.get("days") ?? 1);
  if (!Number.isInteger(asked) || asked < 1 || asked > 14) return new Reply(400, { code: "MEAL_COUNTS_RANGE", message: "days: ett helt antal dagar, 1 till 14." });
  const days = Array.from({ length: asked }, (_, i) => dayOf(addDays(from, i)));
  return { from, to: days.at(-1)!.date, cutoff: SETTINGS.cutoffTime, staffModelled: true, days };
}

function settings(context: GatewayContext): MealSettings | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" ? SETTINGS : new Reply(403, { message: "Forbidden." });
}

function saveSettings(context: GatewayContext): MealSettings | Reply {
  const current = settings(context);
  if (current instanceof Reply) return current;
  // The stub keeps nothing between requests, so one suite cannot leave a switch for the next.
  return { ...current, ...((context.body ?? {}) as Partial<MealSettings>) };
}

export const mealRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/meal-counts", counts),
  route("GET", "/api/v1/meal-counts/settings", settings),
  route("PUT", "/api/v1/meal-counts/settings", saveSettings),
];
