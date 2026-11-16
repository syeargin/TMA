import { attachedText } from './attached';

const none = { answers: 0, meals: 0, matches: 0, workMatches: 0, refJobs: false, dayPlan: false, agenda: false, attendance: 0 };
describe('attachedText', () => {
  it('lists what an event takes with it', () => {
    expect(attachedText(none)).toBe('');
    expect(attachedText({ ...none, answers: 1 })).toBe('1 answer');
    expect(attachedText({ ...none, answers: 3, matches: 1, refJobs: true })).toBe('3 answers, 1 match and the ref jobs');
  });
});
