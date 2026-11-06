// What counts as an app-generated name (so a real place name should replace it), shared by import + build.

// Strava's "<time of day> <sport>", sometimes behind a weather emoji a third-party app prepended,
// plus bare "Activity" and the date-only names old apps exported ("05/01/2012")
const STRAVA_DEFAULT = /^(?:(?:Morning|Lunch|Afternoon|Evening|Night) )?(Activity|Run|Trail Run|Virtual Run|Ride|E-Bike Ride|Mountain Bike Ride|Gravel Ride|Virtual Ride|Walk|Hike|Swim|Workout|Weight Training|Yoga|Alpine Ski|Backcountry Ski|Nordic Ski|Snowboard|Snowshoe|Kayaking|Canoe|Rowing|Stand Up Paddling|Surfing|Windsurf|Kitesurf|Sail|Rock Climb|Elliptical|Stair-Stepper|Crossfit|HIIT|Pilates|Ice Skate|Inline Skate)$/;
const DATE_ONLY = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

export function isDefaultName(n) {
  const s = (n ?? "").replace(/^[\p{Extended_Pictographic}️‍\s]+/u, "").trim();
  return !s || STRAVA_DEFAULT.test(s) || DATE_ONLY.test(s);
}

// Garmin's naming style: "<place> <Sport>"
const SPORT_WORD = {
  running: "Running", trail_running: "Trail Running", treadmill_running: "Treadmill Running",
  cycling: "Cycling", mountain_biking: "Mountain Biking", gravel_cycling: "Gravel Cycling", indoor_cycling: "Indoor Cycling",
  e_bike_fitness: "eBiking", walking: "Walking", hiking: "Hiking",
  resort_skiing_snowboarding_ws: "Resort Skiing/Snowboarding", backcountry_skiing_snowboarding_ws: "Backcountry Skiing",
  cross_country_skiing_ws: "Cross Country Skiing", open_water_swimming: "Swimming", paddling: "Paddling",
  strength_training: "Strength", other: "Activity",
};
export const garminStyleName = (place, type) => [place, SPORT_WORD[type] ?? "Activity"].filter(Boolean).join(" ");
