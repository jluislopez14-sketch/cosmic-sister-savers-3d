// StoryData.js — Comic-panel scripts and TTS voice cues per mission.
//
// Each mission has:
//   title  — comic banner string
//   panels — comic-strip blocks: { who, side, text }
//   voice  — [[character, text], ...] spoken at mission start

export const STORY = {
  mission1: {
    title: 'MISSION 1 · ESCAPING EARTH',
    panels: [
      { who: 'GREENY 👽',  side: 'left',  text: "Hurry! The Gloom Syndicate is blocking Earth!" },
      { who: 'ALAIA 👧🏻',  side: 'right', text: "Smile Energy at maximum! Say cheese!" },
    ],
    voice: [
      ['greeny', 'Hurry! The Gloom Syndicate is blocking Earth!'],
      ['alaia',  'Smile Energy at maximum! Say cheese!'],
    ],
  },

  mission2: {
    title: 'MISSION 2 · ATMOSPHERIC RE-ENTRY',
    panels: [
      { who: 'LISABEL 👧🏽', side: 'left',  text: "Hold on tight! Re-entry is going to be bumpy!" },
      { who: 'ALAIA 👧🏻',   side: 'right', text: "Woah, look at those huge space rocks!" },
    ],
    voice: [
      ['lisabel', 'Hold on tight! Re-entry is going to be bumpy!'],
      ['alaia',   'Woah, look at those huge space rocks!'],
    ],
  },

  mission3: {
    title: 'MISSION 3 · THE CRYSTAL CAVES',
    panels: [
      { who: 'LISABEL 👧🏽', side: 'left',  text: "We have to find the source of the Gloom on foot!" },
      { who: 'ALAIA 👧🏻',   side: 'right', text: "Eww, don't step in the purple slime!" },
    ],
    voice: [
      ['lisabel', "We have to find the source of the Gloom on foot!"],
      ['alaia',   "Eww, don't step in the purple slime!"],
    ],
  },

  mission4: {
    title: "MISSION 4 · LORD GRUMP'S LANDING PAD",
    panels: [
      { who: 'LORD GRUMP 👹', side: 'left',  text: "You will never reach the smile core!" },
      { who: 'GREENY 👽',     side: 'right', text: "Now! Call your parents!" },
    ],
    voice: [
      ['narrator', 'Lord Grump approaches!'],
      ['greeny',   'Now! Call your parents!'],
    ],
  },

  // Spoken when the merge overlay opens (boss reaches 50% HP).
  merge: {
    voice: [
      ['jose',    'Commander Equilibrium, reporting for duty!'],
      ['mom',     'Captain Sparkle is here to light things up!'],
      ['alaia',   'Best...'],
      ['lisabel', 'Family...'],
      ['jose',    'Reunion...'],
      ['mom',     'EVER!'],
    ],
  },

  victory: {
    title: 'EPILOGUE',
    panels: [
      { who: 'LORD GRUMP 👹', side: 'left',  text: "Noooo! Not the Duo-Drive! My grumpiness... is fading...!" },
      { who: 'GREENY 👽',     side: 'right', text: "You did it! The whole family — together — saved the universe!" },
      { who: 'THE FAMILY 🌟', side: 'left',  text: "Cosmic Sister Savers — assemble!" },
    ],
  },
};
