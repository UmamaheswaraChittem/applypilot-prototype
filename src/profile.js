/**
 * User Profile — centralized profile for all platforms
 * Loaded from .env or passed directly for multi-user support
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

function loadProfile(overrides = {}) {
  return {
    firstName: overrides.firstName || process.env.FIRST_NAME || '',
    lastName: overrides.lastName || process.env.LAST_NAME || '',
    fullName: overrides.fullName || `${overrides.firstName || process.env.FIRST_NAME || ''} ${overrides.lastName || process.env.LAST_NAME || ''}`.trim(),
    email: overrides.email || process.env.LINKEDIN_EMAIL || process.env.NAUKRI_EMAIL || '',
    phone: overrides.phone || process.env.PHONE || '',
    city: overrides.city || process.env.CITY || 'Hyderabad',
    country: overrides.country || 'India',
    state: overrides.state || 'Telangana',
    pincode: overrides.pincode || '500081',

    // Professional
    totalExperience: parseInt(overrides.totalExperience || process.env.TOTAL_EXPERIENCE || '3'),
    expectedCtcLPA: parseInt(overrides.expectedCtcLPA || process.env.EXPECTED_CTC_LPA || '12'),
    currentCtcLPA: parseInt(overrides.currentCtcLPA || process.env.CURRENT_CTC_LPA || '10'),
    noticeDays: parseInt(overrides.noticeDays || process.env.NOTICE_DAYS || '30'),
    skills: (overrides.skills || process.env.PROFILE_SKILLS || '').split(',').map(s => s.trim()).filter(Boolean),
    currentCompany: overrides.currentCompany || process.env.CURRENT_COMPANY || 'EdgeVerve Systems',
    currentTitle: overrides.currentTitle || process.env.CURRENT_TITLE || 'Technology Analyst',
    degree: overrides.degree || process.env.DEGREE || "Bachelor's",
    university: overrides.university || process.env.UNIVERSITY || '',

    // URLs
    linkedinUrl: overrides.linkedinUrl || process.env.LINKEDIN_URL || '',
    githubUrl: overrides.githubUrl || process.env.GITHUB_URL || '',
    portfolioUrl: overrides.portfolioUrl || process.env.PORTFOLIO_URL || '',

    // Resume
    resumePath: overrides.resumePath || process.env.RESUME_PATH || '',

    // Credentials
    linkedinEmail: overrides.linkedinEmail || process.env.LINKEDIN_EMAIL || '',
    linkedinPassword: overrides.linkedinPassword || process.env.LINKEDIN_PASSWORD || '',
    naukriEmail: overrides.naukriEmail || process.env.NAUKRI_EMAIL || '',
    naukriPassword: overrides.naukriPassword || process.env.NAUKRI_PASSWORD || '',

    // Experience map (skill -> years)
    experienceMap: overrides.experienceMap || {},

    // Cover letter
    coverLetter: overrides.coverLetter || '',

    // Work authorization
    authorizedToWork: overrides.authorizedToWork !== undefined ? overrides.authorizedToWork : true,
    requiresSponsorship: overrides.requiresSponsorship !== undefined ? overrides.requiresSponsorship : false,
    willingToRelocate: overrides.willingToRelocate !== undefined ? overrides.willingToRelocate : true,
    remotePreference: overrides.remotePreference || 'yes', // yes, no, hybrid

    // Demographics (answer "decline to state" or "no" by default)
    veteranStatus: 'no',
    disabilityStatus: 'no',
    gender: 'decline',
    ethnicity: 'decline',

    // Age / DOB
    age: overrides.age || 25,
    dob: overrides.dob || '',
  };
}

/**
 * Get experience years for a specific technology from the experience map
 */
function getExperienceYears(profile, ctx) {
  const lower = ctx.toLowerCase();
  for (const [skill, years] of Object.entries(profile.experienceMap)) {
    if (lower.includes(skill.toLowerCase())) return years;
  }
  return null;
}

/**
 * Generate a default cover letter from profile
 */
function generateCoverLetter(profile) {
  if (profile.coverLetter) return profile.coverLetter;
  const skills = profile.skills.slice(0, 5).join(', ');
  return `I am a ${profile.currentTitle || 'software developer'} with ${profile.totalExperience} years of experience` +
    (skills ? ` in ${skills}` : '') +
    `. I am passionate about building quality software and eager to contribute to your team.`;
}

module.exports = { loadProfile, getExperienceYears, generateCoverLetter };
