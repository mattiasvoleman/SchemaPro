/*
 * GENERATED from S1 by scripts/ss12000/generate-s1-provider.cjs — do not edit
 * by hand (js-yaml over the YAML below, allOf merged, $refs named): every
 * schema the v2.0 provider emits or reads, and every query parameter of every
 * operation it serves, exactly as S1 states them.
 *
 * S1: SIS TK450, "SS12000 OpenAPI 3.0", openapi_ss12000_version2_1_0.yaml,
 * info.version 2.1.0, openapi 3.0.2,
 * https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml
 * sha256 aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28.
 *
 * Spellings are S1's own, misspellings included: DeletedEntities_data.activitites,
 * the callback body's modifiedEntites. POST /calendarEvents/lookup answers
 * AttendancesArray in S1, an evident slip the provider does not copy (it
 * answers CalendarEvent[]; docs/integration-api.md says so).
 */
/* eslint-disable */

export const S1_SHA256 = 'aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28' as const;
export const S1_VERSION = '2.1.0' as const;

export interface S1Property {
  kind: 'string' | 'integer' | 'boolean' | 'number' | 'object' | 'array';
  format?: string;
  enum?: readonly string[];
  enumName?: string;
  ref?: string;
  items?: S1Property;
  minItems?: number;
  nullable?: boolean;
  minimum?: number;
}

export interface S1Schema {
  properties: Record<string, S1Property>;
  required: readonly string[];
}

export const S1_SCHEMAS: Record<string, S1Schema> = {
  "Organisations": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Organisation"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "PersonsExpanded": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "PersonExpanded"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "Duties": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "DutyExpanded"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "GroupsExpanded": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "GroupExpanded"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "Activities": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "ActivityExpanded"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "CalendarEvents": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "CalendarEvent"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "Rooms": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Room"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "Syllabuses": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Syllabus"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "Subscriptions": {
    "properties": {
      "data": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Subscription"
        }
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "DeletedEntities": {
    "properties": {
      "data": {
        "kind": "object",
        "ref": "DeletedEntities_data"
      },
      "pageToken": {
        "kind": "string",
        "nullable": true
      }
    },
    "required": [
      "data"
    ]
  },
  "CreateSubscription": {
    "properties": {
      "name": {
        "kind": "string"
      },
      "target": {
        "kind": "string"
      },
      "resourceTypes": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "CreateSubscription_resourceTypes_inner"
        }
      }
    },
    "required": [
      "name",
      "resourceTypes",
      "target"
    ]
  },
  "_subscriptions_get_request": {
    "properties": {
      "modifiedEntites": {
        "kind": "array",
        "items": {
          "kind": "string",
          "enum": [
            "Absence",
            "AttendanceEvent",
            "Attendance",
            "Grade",
            "CalendarEvent",
            "AttendanceSchedule",
            "Resource",
            "Room",
            "Activity",
            "Duty",
            "Placement",
            "StudyPlan",
            "Programme",
            "Syllabus",
            "SchoolUnitOffering",
            "Group",
            "Person",
            "Organisation"
          ],
          "enumName": "EndPointsEnum"
        }
      },
      "deletedEntities": {
        "kind": "boolean"
      }
    },
    "required": []
  },
  "Error": {
    "properties": {
      "code": {
        "kind": "string"
      },
      "message": {
        "kind": "string"
      }
    },
    "required": [
      "code",
      "message"
    ]
  },
  "IdLookup": {
    "properties": {
      "ids": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      }
    },
    "required": []
  },
  "_organisations_lookup_post_request": {
    "properties": {
      "ids": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "schoolUnitCodes": {
        "kind": "array",
        "items": {
          "kind": "string"
        }
      },
      "organisationCodes": {
        "kind": "array",
        "items": {
          "kind": "string"
        }
      }
    },
    "required": []
  },
  "_persons_lookup_post_request": {
    "properties": {
      "ids": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "civicNos": {
        "kind": "array",
        "items": {
          "kind": "string"
        }
      }
    },
    "required": []
  },
  "_activities_lookup_post_request": {
    "properties": {
      "ids": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "teachers": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "members": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      }
    },
    "required": []
  },
  "_calendarEvents_lookup_post_request": {
    "properties": {
      "ids": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "activities": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "student": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "teacher": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      }
    },
    "required": []
  },
  "Subscription": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "expires": {
        "kind": "string",
        "format": "date-time"
      },
      "name": {
        "kind": "string"
      },
      "target": {
        "kind": "string"
      },
      "resourceTypes": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "CreateSubscription_resourceTypes_inner"
        }
      }
    },
    "required": [
      "expires",
      "id",
      "name",
      "resourceTypes",
      "target"
    ]
  },
  "Organisation": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "displayName": {
        "kind": "string"
      },
      "organisationCode": {
        "kind": "string"
      },
      "organisationType": {
        "kind": "string",
        "enum": [
          "Huvudman",
          "Verksamhetsområde",
          "Förvaltning",
          "Rektorsområde",
          "Skola",
          "Skolenhet",
          "Varumärke",
          "Bolag",
          "Övrigt"
        ],
        "enumName": "OrganisationTypeEnum"
      },
      "organisationNumber": {
        "kind": "string"
      },
      "parentOrganisation": {
        "kind": "object",
        "ref": "Organisation_parentOrganisation"
      },
      "schoolUnitCode": {
        "kind": "string"
      },
      "schoolTypes": {
        "kind": "array",
        "items": {
          "kind": "string",
          "enum": [
            "FS",
            "FKLASS",
            "FTH",
            "OPPFTH",
            "GR",
            "GRS",
            "TR",
            "SP",
            "SAM",
            "GY",
            "GYS",
            "VUX",
            "VUXSFI",
            "VUXGR",
            "VUXGY",
            "VUXSARGR",
            "VUXSARTR",
            "VUXSARGY",
            "SFI",
            "SARVUX",
            "SARVUXGR",
            "SARVUXGY",
            "KU",
            "YH",
            "FHS",
            "STF",
            "KKU",
            "HS",
            "ABU",
            "AU"
          ],
          "enumName": "SchoolTypesEnum"
        }
      },
      "address": {
        "kind": "object",
        "ref": "Organisation_address"
      },
      "municipalityCode": {
        "kind": "string"
      },
      "url": {
        "kind": "string",
        "format": "uri"
      },
      "email": {
        "kind": "string",
        "format": "email"
      },
      "phoneNumber": {
        "kind": "string"
      },
      "contactInfo": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "ContactInfo"
        }
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      }
    },
    "required": [
      "displayName",
      "id",
      "meta",
      "organisationType"
    ]
  },
  "PersonExpanded": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "givenName": {
        "kind": "string"
      },
      "middleName": {
        "kind": "string"
      },
      "familyName": {
        "kind": "string"
      },
      "eduPersonPrincipalNames": {
        "kind": "array",
        "items": {
          "kind": "string"
        }
      },
      "externalIdentifiers": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "externalIdentifier"
        }
      },
      "civicNo": {
        "kind": "object",
        "ref": "Person_civicNo"
      },
      "birthDate": {
        "kind": "string",
        "format": "date"
      },
      "sex": {
        "kind": "string",
        "enum": [
          "Man",
          "Kvinna",
          "Okänt"
        ]
      },
      "securityMarking": {
        "kind": "string",
        "enum": [
          "Ingen",
          "Sekretessmarkering",
          "Skyddad folkbokföring"
        ]
      },
      "personStatus": {
        "kind": "string",
        "enum": [
          "Aktiv",
          "Utvandrad",
          "Avliden"
        ]
      },
      "emails": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Email"
        }
      },
      "phoneNumbers": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Phonenumber"
        }
      },
      "addresses": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Person_addresses_inner"
        }
      },
      "photo": {
        "kind": "string",
        "format": "uri"
      },
      "enrolments": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Enrolment"
        }
      },
      "responsibles": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Person_responsibles_inner"
        }
      },
      "_embedded": {
        "kind": "object",
        "ref": "PersonExpanded_allOf__embedded"
      }
    },
    "required": [
      "familyName",
      "givenName",
      "id",
      "meta"
    ]
  },
  "DutyExpanded": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "person": {
        "kind": "object",
        "ref": "Duty_person"
      },
      "assignmentRole": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Duty_assignmentRole_inner"
        }
      },
      "dutyAt": {
        "kind": "object",
        "ref": "OrganisationReference"
      },
      "dutyRole": {
        "kind": "string",
        "enum": [
          "Rektor",
          "Lärare",
          "Förskollärare",
          "Barnskötare",
          "Bibliotekarie",
          "Lärarassistent",
          "Fritidspedagog",
          "Annan personal",
          "Studie- och yrkesvägledare",
          "Förstelärare",
          "Kurator",
          "Skolsköterska",
          "Skolläkare",
          "Skolpsykolog",
          "Speciallärare/specialpedagog",
          "Skoladministratör",
          "Övrig arbetsledning",
          "Övrig pedagogisk personal",
          "Förskolechef"
        ],
        "enumName": "DutyRole"
      },
      "description": {
        "kind": "string"
      },
      "signature": {
        "kind": "string"
      },
      "dutyPercent": {
        "kind": "integer"
      },
      "hoursPerYear": {
        "kind": "integer"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "_embedded": {
        "kind": "object",
        "ref": "DutyExpanded_allOf__embedded"
      }
    },
    "required": [
      "dutyAt",
      "dutyRole",
      "id",
      "meta",
      "startDate"
    ]
  },
  "GroupExpanded": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "displayName": {
        "kind": "string"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "groupType": {
        "kind": "string",
        "enum": [
          "Undervisning",
          "Klass",
          "Mentor",
          "Provgrupp",
          "Schema",
          "Avdelning",
          "Personalgrupp",
          "Övrigt"
        ],
        "enumName": "GroupTypesEnum"
      },
      "schoolType": {
        "kind": "string",
        "enum": [
          "FS",
          "FKLASS",
          "FTH",
          "OPPFTH",
          "GR",
          "GRS",
          "TR",
          "SP",
          "SAM",
          "GY",
          "GYS",
          "VUX",
          "VUXSFI",
          "VUXGR",
          "VUXGY",
          "VUXSARGR",
          "VUXSARTR",
          "VUXSARGY",
          "SFI",
          "SARVUX",
          "SARVUXGR",
          "SARVUXGY",
          "KU",
          "YH",
          "FHS",
          "STF",
          "KKU",
          "HS",
          "ABU",
          "AU"
        ],
        "enumName": "SchoolTypesEnum"
      },
      "organisation": {
        "kind": "object",
        "ref": "OrganisationReference"
      },
      "groupMemberships": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "GroupMembership"
        }
      },
      "_embedded": {
        "kind": "object",
        "ref": "GroupExpanded_allOf__embedded"
      }
    },
    "required": [
      "displayName",
      "groupType",
      "id",
      "meta",
      "organisation",
      "startDate"
    ]
  },
  "ActivityExpanded": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "displayName": {
        "kind": "string"
      },
      "calendarEventsRequired": {
        "kind": "boolean"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "activityType": {
        "kind": "string",
        "enum": [
          "Undervisning",
          "Elevaktivitet",
          "Provaktivitet",
          "Läraraktivitet",
          "Övrigt"
        ]
      },
      "comment": {
        "kind": "string"
      },
      "minutesPlanned": {
        "kind": "integer"
      },
      "groups": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "GroupReference"
        },
        "minItems": 1
      },
      "teachers": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "DutyAssignment"
        }
      },
      "syllabus": {
        "kind": "object",
        "ref": "Activity_syllabus"
      },
      "organisation": {
        "kind": "object",
        "ref": "Activity_organisation"
      },
      "parentActivity": {
        "kind": "object",
        "ref": "Activity_parentActivity"
      },
      "_embedded": {
        "kind": "object",
        "ref": "ActivityExpanded_allOf__embedded"
      }
    },
    "required": [
      "calendarEventsRequired",
      "displayName",
      "groups",
      "id",
      "meta",
      "organisation",
      "startDate"
    ]
  },
  "CalendarEvent": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "activity": {
        "kind": "object",
        "ref": "CalendarEvent_activity"
      },
      "startTime": {
        "kind": "string",
        "format": "date-time"
      },
      "endTime": {
        "kind": "string",
        "format": "date-time"
      },
      "cancelled": {
        "kind": "boolean"
      },
      "teachingLengthTeacher": {
        "kind": "integer"
      },
      "teachingLengthStudent": {
        "kind": "integer"
      },
      "comment": {
        "kind": "string"
      },
      "studentExceptions": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "StudentException"
        }
      },
      "teacherExceptions": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "TeacherException"
        }
      },
      "rooms": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "CalendarEvent_rooms_inner"
        }
      },
      "resources": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "CalendarEvent_resources_inner"
        }
      },
      "_embedded": {
        "kind": "object",
        "ref": "CalendarEvent__embedded"
      }
    },
    "required": [
      "activity",
      "endTime",
      "id",
      "meta",
      "startTime"
    ]
  },
  "Room": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "displayName": {
        "kind": "string"
      },
      "seats": {
        "kind": "integer"
      },
      "owner": {
        "kind": "object",
        "ref": "OrganisationReference"
      }
    },
    "required": [
      "displayName",
      "id",
      "meta",
      "owner"
    ]
  },
  "Syllabus": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "schoolType": {
        "kind": "string",
        "enum": [
          "FS",
          "FKLASS",
          "FTH",
          "OPPFTH",
          "GR",
          "GRS",
          "TR",
          "SP",
          "SAM",
          "GY",
          "GYS",
          "VUX",
          "VUXSFI",
          "VUXGR",
          "VUXGY",
          "VUXSARGR",
          "VUXSARTR",
          "VUXSARGY",
          "SFI",
          "SARVUX",
          "SARVUXGR",
          "SARVUXGY",
          "KU",
          "YH",
          "FHS",
          "STF",
          "KKU",
          "HS",
          "ABU",
          "AU"
        ],
        "enumName": "SchoolTypesEnum"
      },
      "subjectCode": {
        "kind": "string"
      },
      "subjectName": {
        "kind": "string"
      },
      "subjectDesignation": {
        "kind": "string"
      },
      "courseCode": {
        "kind": "string"
      },
      "courseName": {
        "kind": "string"
      },
      "startSchoolYear": {
        "kind": "integer",
        "minimum": 0
      },
      "endSchoolYear": {
        "kind": "integer",
        "minimum": 0
      },
      "points": {
        "kind": "integer"
      },
      "curriculum": {
        "kind": "string",
        "enum": [
          "Lgy70",
          "Lgr80",
          "Lpo94",
          "Lpf94",
          "Lpfö98",
          "GR2000",
          "GY2000",
          "GYSÄR2000",
          "GYVUX2000",
          "GYVUX2001",
          "GYVUX2002",
          "GR2011",
          "GRSÄR2011",
          "SPEC2011",
          "SAM2011",
          "Lvux12",
          "GY2011",
          "GYSÄR2013",
          "VU2013"
        ],
        "enumName": "CurriculumEnum"
      },
      "languageCode": {
        "kind": "string"
      },
      "specialisationCourseContent": {
        "kind": "object",
        "ref": "SpecialisationCourseContent"
      },
      "official": {
        "kind": "boolean"
      }
    },
    "required": [
      "id",
      "meta",
      "official",
      "schoolType",
      "subjectName"
    ]
  },
  "DeletedEntities_data": {
    "properties": {
      "absences": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "attendanceEvents": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "attendances": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "grades": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "calendarEvents": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "attendanceSchedules": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "resources": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "rooms": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "activitites": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "duties": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "placements": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "studyPlans": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "programmes": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "syllabuses": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "schoolUnitOfferings": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "groups": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "persons": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      },
      "organisations": {
        "kind": "array",
        "items": {
          "kind": "string",
          "format": "uuid"
        }
      }
    },
    "required": []
  },
  "CreateSubscription_resourceTypes_inner": {
    "properties": {
      "resource": {
        "kind": "string",
        "enum": [
          "Absence",
          "AttendanceEvent",
          "Attendance",
          "Grade",
          "CalendarEvent",
          "AttendanceSchedule",
          "Resource",
          "Room",
          "Activity",
          "Duty",
          "Placement",
          "StudyPlan",
          "Programme",
          "Syllabus",
          "SchoolUnitOffering",
          "Group",
          "Person",
          "Organisation"
        ],
        "enumName": "EndPointsEnum"
      }
    },
    "required": []
  },
  "Meta": {
    "properties": {
      "created": {
        "kind": "string",
        "format": "date-time"
      },
      "modified": {
        "kind": "string",
        "format": "date-time"
      }
    },
    "required": [
      "created",
      "modified"
    ]
  },
  "Organisation_parentOrganisation": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Organisation_address": {
    "properties": {
      "type": {
        "kind": "string",
        "enum": [
          "Besöksadress",
          "Leveransadress",
          "Postadress",
          "Fakturaadress"
        ]
      },
      "streetAddress": {
        "kind": "string"
      },
      "locality": {
        "kind": "string"
      },
      "postalCode": {
        "kind": "string"
      },
      "countyCode": {
        "kind": "integer"
      },
      "municipalityCode": {
        "kind": "integer"
      },
      "realEstateDesignation": {
        "kind": "string"
      },
      "country": {
        "kind": "string"
      }
    },
    "required": [
      "locality",
      "postalCode",
      "streetAddress"
    ]
  },
  "ContactInfo": {
    "properties": {
      "infoType": {
        "kind": "string",
        "enum": [
          "Support",
          "Publik"
        ]
      },
      "info": {
        "kind": "string"
      }
    },
    "required": []
  },
  "externalIdentifier": {
    "properties": {
      "value": {
        "kind": "string"
      },
      "context": {
        "kind": "string"
      },
      "globallyUnique": {
        "kind": "boolean"
      }
    },
    "required": [
      "context",
      "globallyUnique",
      "value"
    ]
  },
  "Person_civicNo": {
    "properties": {
      "value": {
        "kind": "string"
      },
      "nationality": {
        "kind": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "Email": {
    "properties": {
      "value": {
        "kind": "string",
        "format": "email"
      },
      "type": {
        "kind": "string",
        "enum": [
          "Privat",
          "Skola elev",
          "Skola personal",
          "Arbete övrigt"
        ]
      }
    },
    "required": [
      "type",
      "value"
    ]
  },
  "Phonenumber": {
    "properties": {
      "value": {
        "kind": "string"
      },
      "type": {
        "kind": "string",
        "enum": [
          "Hem",
          "Arbete"
        ]
      },
      "mobile": {
        "kind": "boolean"
      }
    },
    "required": [
      "mobile",
      "type",
      "value"
    ]
  },
  "Person_addresses_inner": {
    "properties": {
      "type": {
        "kind": "string",
        "enum": [
          "Folkbokföring",
          "Särskild postadress",
          "Tillfällig adress",
          "Postadress"
        ]
      },
      "streetAddress": {
        "kind": "string"
      },
      "locality": {
        "kind": "string"
      },
      "postalCode": {
        "kind": "string"
      },
      "countyCode": {
        "kind": "integer"
      },
      "municipalityCode": {
        "kind": "integer"
      },
      "realEstateDesignation": {
        "kind": "string"
      },
      "country": {
        "kind": "string"
      }
    },
    "required": [
      "country",
      "locality",
      "postalCode",
      "streetAddress"
    ]
  },
  "Enrolment": {
    "properties": {
      "enroledAt": {
        "kind": "object",
        "ref": "SchoolUnitReference"
      },
      "schoolYear": {
        "kind": "integer",
        "minimum": 0
      },
      "schoolType": {
        "kind": "string",
        "enum": [
          "FS",
          "FKLASS",
          "FTH",
          "OPPFTH",
          "GR",
          "GRS",
          "TR",
          "SP",
          "SAM",
          "GY",
          "GYS",
          "VUX",
          "VUXSFI",
          "VUXGR",
          "VUXGY",
          "VUXSARGR",
          "VUXSARTR",
          "VUXSARGY",
          "SFI",
          "SARVUX",
          "SARVUXGR",
          "SARVUXGY",
          "KU",
          "YH",
          "FHS",
          "STF",
          "KKU",
          "HS",
          "ABU",
          "AU"
        ],
        "enumName": "SchoolTypesEnum"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "cancelled": {
        "kind": "boolean"
      },
      "educationCode": {
        "kind": "string"
      },
      "programme": {
        "kind": "object",
        "ref": "Enrolment_programme"
      },
      "specification": {
        "kind": "string"
      }
    },
    "required": [
      "enroledAt",
      "schoolType",
      "startDate"
    ]
  },
  "Person_responsibles_inner": {
    "properties": {
      "person": {
        "kind": "object",
        "ref": "PersonReference"
      },
      "relationType": {
        "kind": "string",
        "enum": [
          "Vårdnadshavare",
          "Annan ansvarig",
          "God man",
          "Utsedd behörig"
        ],
        "enumName": "RelationTypesEnum"
      }
    },
    "required": []
  },
  "PersonExpanded_allOf__embedded": {
    "properties": {
      "responsibleFor": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Person_responsibles_inner"
        }
      },
      "placements": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Placement"
        }
      },
      "ownedPlacements": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Placement"
        }
      },
      "duties": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Duty"
        }
      },
      "groupMemberships": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "PersonExpanded_allOf__embedded_groupMemberships"
        }
      }
    },
    "required": []
  },
  "Duty_person": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      },
      "securityMarking": {
        "kind": "string",
        "enum": [
          "Ingen",
          "Sekretessmarkering",
          "Skyddad folkbokföring"
        ]
      }
    },
    "required": [
      "id"
    ]
  },
  "Duty_assignmentRole_inner": {
    "properties": {
      "group": {
        "kind": "object",
        "ref": "GroupReference"
      },
      "assignmentRoleType": {
        "kind": "string",
        "enum": [
          "Mentor",
          "Förskollärare",
          "Barnskötare",
          "Fritidspedagog",
          "Specialpedagog",
          "Elevhälsopersonal",
          "Pedagogisk ledare",
          "Schemaläggare",
          "Lärarassistent",
          "Administrativ personal"
        ],
        "enumName": "AssignmentRoleTypeEnum"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      }
    },
    "required": [
      "assignmentRoleType",
      "group"
    ]
  },
  "OrganisationReference": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "DutyExpanded_allOf__embedded": {
    "properties": {
      "person": {
        "kind": "object",
        "ref": "Person"
      }
    },
    "required": []
  },
  "GroupMembership": {
    "properties": {
      "person": {
        "kind": "object",
        "ref": "PersonReference"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      }
    },
    "required": [
      "person"
    ]
  },
  "GroupExpanded_allOf__embedded": {
    "properties": {
      "assignmentRoles": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "GroupExpanded_allOf__embedded_assignmentRoles"
        }
      }
    },
    "required": []
  },
  "GroupReference": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "DutyAssignment": {
    "properties": {
      "duty": {
        "kind": "object",
        "ref": "DutyReference"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "minutesPlanned": {
        "kind": "integer"
      },
      "grader": {
        "kind": "boolean"
      }
    },
    "required": [
      "duty"
    ]
  },
  "Activity_syllabus": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Activity_organisation": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Activity_parentActivity": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "ActivityExpanded_allOf__embedded": {
    "properties": {
      "groups": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Group"
        }
      },
      "syllabus": {
        "kind": "object",
        "ref": "Syllabus"
      },
      "teachers": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Duty"
        }
      }
    },
    "required": []
  },
  "CalendarEvent_activity": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "StudentException": {
    "properties": {
      "student": {
        "kind": "object",
        "ref": "PersonReference"
      },
      "participates": {
        "kind": "boolean"
      },
      "startTime": {
        "kind": "string",
        "format": "date-time"
      },
      "endTime": {
        "kind": "string",
        "format": "date-time"
      },
      "teachingLength": {
        "kind": "integer"
      }
    },
    "required": [
      "participates",
      "student"
    ]
  },
  "TeacherException": {
    "properties": {
      "duty": {
        "kind": "object",
        "ref": "DutyReference"
      },
      "participates": {
        "kind": "boolean"
      },
      "startTime": {
        "kind": "string",
        "format": "date-time"
      },
      "endTime": {
        "kind": "string",
        "format": "date-time"
      },
      "teachingLength": {
        "kind": "integer"
      }
    },
    "required": [
      "duty",
      "participates"
    ]
  },
  "CalendarEvent_rooms_inner": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "CalendarEvent_resources_inner": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "CalendarEvent__embedded": {
    "properties": {
      "activity": {
        "kind": "object",
        "ref": "Activity"
      },
      "attendance": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Attendance"
        }
      }
    },
    "required": []
  },
  "SpecialisationCourseContent": {
    "properties": {
      "title": {
        "kind": "string"
      },
      "description": {
        "kind": "string"
      },
      "titleEnglish": {
        "kind": "string"
      },
      "descriptionEnglish": {
        "kind": "string"
      }
    },
    "required": [
      "description",
      "title"
    ]
  },
  "SchoolUnitReference": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Enrolment_programme": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "PersonReference": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      },
      "securityMarking": {
        "kind": "string",
        "enum": [
          "Ingen",
          "Sekretessmarkering",
          "Skyddad folkbokföring"
        ]
      }
    },
    "required": [
      "id"
    ]
  },
  "Placement": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "placedAt": {
        "kind": "object",
        "ref": "Placement_placedAt"
      },
      "group": {
        "kind": "object",
        "ref": "Placement_group"
      },
      "child": {
        "kind": "object",
        "ref": "Placement_child"
      },
      "owners": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "PersonReference"
        }
      },
      "schoolType": {
        "kind": "string",
        "enum": [
          "FS",
          "FTH",
          "OPPFTH"
        ]
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "reason": {
        "kind": "string",
        "enum": [
          "Omsorgsbehov",
          "Erbjuden tid",
          "Eget behov"
        ]
      },
      "maxWeeklyScheduleHours": {
        "kind": "integer"
      }
    },
    "required": [
      "child",
      "id",
      "meta",
      "placedAt",
      "schoolType",
      "startDate"
    ]
  },
  "Duty": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "person": {
        "kind": "object",
        "ref": "Duty_person"
      },
      "assignmentRole": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Duty_assignmentRole_inner"
        }
      },
      "dutyAt": {
        "kind": "object",
        "ref": "OrganisationReference"
      },
      "dutyRole": {
        "kind": "string",
        "enum": [
          "Rektor",
          "Lärare",
          "Förskollärare",
          "Barnskötare",
          "Bibliotekarie",
          "Lärarassistent",
          "Fritidspedagog",
          "Annan personal",
          "Studie- och yrkesvägledare",
          "Förstelärare",
          "Kurator",
          "Skolsköterska",
          "Skolläkare",
          "Skolpsykolog",
          "Speciallärare/specialpedagog",
          "Skoladministratör",
          "Övrig arbetsledning",
          "Övrig pedagogisk personal",
          "Förskolechef"
        ],
        "enumName": "DutyRole"
      },
      "description": {
        "kind": "string"
      },
      "signature": {
        "kind": "string"
      },
      "dutyPercent": {
        "kind": "integer"
      },
      "hoursPerYear": {
        "kind": "integer"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      }
    },
    "required": [
      "dutyAt",
      "dutyRole",
      "id",
      "meta",
      "startDate"
    ]
  },
  "PersonExpanded_allOf__embedded_groupMemberships": {
    "properties": {
      "group": {
        "kind": "object",
        "ref": "GroupFragment"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      }
    },
    "required": []
  },
  "Person": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "givenName": {
        "kind": "string"
      },
      "middleName": {
        "kind": "string"
      },
      "familyName": {
        "kind": "string"
      },
      "eduPersonPrincipalNames": {
        "kind": "array",
        "items": {
          "kind": "string"
        }
      },
      "externalIdentifiers": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "externalIdentifier"
        }
      },
      "civicNo": {
        "kind": "object",
        "ref": "Person_civicNo"
      },
      "birthDate": {
        "kind": "string",
        "format": "date"
      },
      "sex": {
        "kind": "string",
        "enum": [
          "Man",
          "Kvinna",
          "Okänt"
        ]
      },
      "securityMarking": {
        "kind": "string",
        "enum": [
          "Ingen",
          "Sekretessmarkering",
          "Skyddad folkbokföring"
        ]
      },
      "personStatus": {
        "kind": "string",
        "enum": [
          "Aktiv",
          "Utvandrad",
          "Avliden"
        ]
      },
      "emails": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Email"
        }
      },
      "phoneNumbers": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Phonenumber"
        }
      },
      "addresses": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Person_addresses_inner"
        }
      },
      "photo": {
        "kind": "string",
        "format": "uri"
      },
      "enrolments": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Enrolment"
        }
      },
      "responsibles": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "Person_responsibles_inner"
        }
      }
    },
    "required": [
      "familyName",
      "givenName",
      "id",
      "meta"
    ]
  },
  "GroupExpanded_allOf__embedded_assignmentRoles": {
    "properties": {
      "duty": {
        "kind": "object",
        "ref": "DutyReference"
      },
      "assignmentRoleType": {
        "kind": "string",
        "enum": [
          "Mentor",
          "Förskollärare",
          "Barnskötare",
          "Fritidspedagog",
          "Specialpedagog",
          "Elevhälsopersonal",
          "Pedagogisk ledare",
          "Schemaläggare",
          "Lärarassistent",
          "Administrativ personal"
        ],
        "enumName": "AssignmentRoleTypeEnum"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      }
    },
    "required": []
  },
  "DutyReference": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Group": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "displayName": {
        "kind": "string"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "groupType": {
        "kind": "string",
        "enum": [
          "Undervisning",
          "Klass",
          "Mentor",
          "Provgrupp",
          "Schema",
          "Avdelning",
          "Personalgrupp",
          "Övrigt"
        ],
        "enumName": "GroupTypesEnum"
      },
      "schoolType": {
        "kind": "string",
        "enum": [
          "FS",
          "FKLASS",
          "FTH",
          "OPPFTH",
          "GR",
          "GRS",
          "TR",
          "SP",
          "SAM",
          "GY",
          "GYS",
          "VUX",
          "VUXSFI",
          "VUXGR",
          "VUXGY",
          "VUXSARGR",
          "VUXSARTR",
          "VUXSARGY",
          "SFI",
          "SARVUX",
          "SARVUXGR",
          "SARVUXGY",
          "KU",
          "YH",
          "FHS",
          "STF",
          "KKU",
          "HS",
          "ABU",
          "AU"
        ],
        "enumName": "SchoolTypesEnum"
      },
      "organisation": {
        "kind": "object",
        "ref": "OrganisationReference"
      },
      "groupMemberships": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "GroupMembership"
        }
      }
    },
    "required": [
      "displayName",
      "groupType",
      "id",
      "meta",
      "organisation",
      "startDate"
    ]
  },
  "Activity": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "displayName": {
        "kind": "string"
      },
      "calendarEventsRequired": {
        "kind": "boolean"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "activityType": {
        "kind": "string",
        "enum": [
          "Undervisning",
          "Elevaktivitet",
          "Provaktivitet",
          "Läraraktivitet",
          "Övrigt"
        ]
      },
      "comment": {
        "kind": "string"
      },
      "minutesPlanned": {
        "kind": "integer"
      },
      "groups": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "GroupReference"
        },
        "minItems": 1
      },
      "teachers": {
        "kind": "array",
        "items": {
          "kind": "object",
          "ref": "DutyAssignment"
        }
      },
      "syllabus": {
        "kind": "object",
        "ref": "Activity_syllabus"
      },
      "organisation": {
        "kind": "object",
        "ref": "Activity_organisation"
      },
      "parentActivity": {
        "kind": "object",
        "ref": "Activity_parentActivity"
      }
    },
    "required": [
      "calendarEventsRequired",
      "displayName",
      "groups",
      "id",
      "meta",
      "organisation",
      "startDate"
    ]
  },
  "Attendance": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "calendarEvent": {
        "kind": "object",
        "ref": "CalendarEventReference"
      },
      "student": {
        "kind": "object",
        "ref": "Attendance_student"
      },
      "reporter": {
        "kind": "object",
        "ref": "Attendance_reporter"
      },
      "isReported": {
        "kind": "boolean"
      },
      "attendanceMinutes": {
        "kind": "integer"
      },
      "validAbsenceMinutes": {
        "kind": "integer"
      },
      "invalidAbsenceMinutes": {
        "kind": "integer"
      },
      "otherAttendanceMinutes": {
        "kind": "integer"
      },
      "absenceReason": {
        "kind": "string"
      },
      "reportedTimestamp": {
        "kind": "string",
        "format": "date-time"
      }
    },
    "required": [
      "calendarEvent",
      "id",
      "isReported",
      "meta",
      "student"
    ]
  },
  "Placement_placedAt": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Placement_group": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Placement_child": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      },
      "securityMarking": {
        "kind": "string",
        "enum": [
          "Ingen",
          "Sekretessmarkering",
          "Skyddad folkbokföring"
        ]
      }
    },
    "required": [
      "id"
    ]
  },
  "GroupFragment": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "meta": {
        "kind": "object",
        "ref": "Meta"
      },
      "displayName": {
        "kind": "string"
      },
      "startDate": {
        "kind": "string",
        "format": "date"
      },
      "endDate": {
        "kind": "string",
        "format": "date"
      },
      "groupType": {
        "kind": "string",
        "enum": [
          "Undervisning",
          "Klass",
          "Mentor",
          "Provgrupp",
          "Schema",
          "Avdelning",
          "Personalgrupp",
          "Övrigt"
        ],
        "enumName": "GroupTypesEnum"
      },
      "schoolType": {
        "kind": "string",
        "enum": [
          "FS",
          "FKLASS",
          "FTH",
          "OPPFTH",
          "GR",
          "GRS",
          "TR",
          "SP",
          "SAM",
          "GY",
          "GYS",
          "VUX",
          "VUXSFI",
          "VUXGR",
          "VUXGY",
          "VUXSARGR",
          "VUXSARTR",
          "VUXSARGY",
          "SFI",
          "SARVUX",
          "SARVUXGR",
          "SARVUXGY",
          "KU",
          "YH",
          "FHS",
          "STF",
          "KKU",
          "HS",
          "ABU",
          "AU"
        ],
        "enumName": "SchoolTypesEnum"
      },
      "organisation": {
        "kind": "object",
        "ref": "OrganisationReference"
      }
    },
    "required": [
      "displayName",
      "groupType",
      "id",
      "meta",
      "organisation",
      "startDate"
    ]
  },
  "CalendarEventReference": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      }
    },
    "required": [
      "id"
    ]
  },
  "Attendance_student": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      },
      "securityMarking": {
        "kind": "string",
        "enum": [
          "Ingen",
          "Sekretessmarkering",
          "Skyddad folkbokföring"
        ]
      }
    },
    "required": [
      "id"
    ]
  },
  "Attendance_reporter": {
    "properties": {
      "id": {
        "kind": "string",
        "format": "uuid"
      },
      "displayName": {
        "kind": "string"
      },
      "securityMarking": {
        "kind": "string",
        "enum": [
          "Ingen",
          "Sekretessmarkering",
          "Skyddad folkbokföring"
        ]
      }
    },
    "required": [
      "id"
    ]
  }
};

export interface S1QueryParameter {
  array: boolean;
  type: 'string' | 'integer' | 'boolean';
  format?: string;
  enum?: readonly string[];
  required?: boolean;
  minimum?: number;
}

export interface S1Operation {
  query: Record<string, S1QueryParameter>;
  body: string | null;
  responses: Record<string, string | null>;
}

export const S1_OPERATIONS: Record<string, S1Operation> = {
  "GET /organisations": {
    "query": {
      "parent": {
        "array": true,
        "type": "string",
        "format": "uuid"
      },
      "schoolUnitCode": {
        "array": true,
        "type": "string"
      },
      "organisationCode": {
        "array": true,
        "type": "string"
      },
      "municipalityCode": {
        "array": false,
        "type": "string"
      },
      "type": {
        "array": true,
        "type": "string",
        "enum": [
          "Huvudman",
          "Verksamhetsområde",
          "Förvaltning",
          "Rektorsområde",
          "Skola",
          "Skolenhet",
          "Varumärke",
          "Bolag",
          "Övrigt"
        ]
      },
      "schoolTypes": {
        "array": true,
        "type": "string",
        "enum": [
          "FS",
          "FKLASS",
          "FTH",
          "OPPFTH",
          "GR",
          "GRS",
          "TR",
          "SP",
          "SAM",
          "GY",
          "GYS",
          "VUX",
          "VUXSFI",
          "VUXGR",
          "VUXGY",
          "VUXSARGR",
          "VUXSARTR",
          "VUXSARGY",
          "SFI",
          "SARVUX",
          "SARVUXGR",
          "SARVUXGY",
          "KU",
          "YH",
          "FHS",
          "STF",
          "KKU",
          "HS",
          "ABU",
          "AU"
        ]
      },
      "startDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "startDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "ModifiedDesc",
          "DisplayNameAsc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "Organisations",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /organisations/lookup": {
    "query": {
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "_organisations_lookup_post_request",
    "responses": {
      "200": "OrganisationsArray",
      "403": "Error",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /organisations/{id}": {
    "query": {
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "Organisation",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /persons": {
    "query": {
      "nameContains": {
        "array": true,
        "type": "string"
      },
      "civicNo": {
        "array": false,
        "type": "string"
      },
      "eduPersonPrincipalName": {
        "array": false,
        "type": "string"
      },
      "identifier.value": {
        "array": false,
        "type": "string"
      },
      "identifier.context": {
        "array": false,
        "type": "string"
      },
      "relationship.entity.type": {
        "array": false,
        "type": "string",
        "enum": [
          "enrolment",
          "duty",
          "placement.child",
          "placement.owner",
          "responsibleFor.enrolment",
          "responsibleFor.placement",
          "groupMembership"
        ]
      },
      "relationship.organisation": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "relationship.startDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "relationship.startDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "relationship.endDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "relationship.endDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "duties",
          "responsibleFor",
          "placements",
          "ownedPlacements",
          "groupMemberships"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "DisplayNameAsc",
          "GivenNameDesc",
          "GivenNameAsc",
          "FamilyNameDesc",
          "FamilyNameAsc",
          "CivicNoAsc",
          "CivicNoDesc",
          "ModifiedDesc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "PersonsExpanded",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /persons/lookup": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "duties",
          "responsibleFor",
          "placements",
          "ownedPlacements",
          "groupMemberships"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "_persons_lookup_post_request",
    "responses": {
      "200": "PersonsExpandedArray",
      "403": "Error",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /persons/{id}": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "duties",
          "responsibleFor",
          "placements",
          "ownedPlacements",
          "groupMemberships"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "PersonExpanded",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /duties": {
    "query": {
      "organisation": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "dutyRole": {
        "array": false,
        "type": "string",
        "enum": [
          "Rektor",
          "Lärare",
          "Förskollärare",
          "Barnskötare",
          "Bibliotekarie",
          "Lärarassistent",
          "Fritidspedagog",
          "Annan personal",
          "Studie- och yrkesvägledare",
          "Förstelärare",
          "Kurator",
          "Skolsköterska",
          "Skolläkare",
          "Skolpsykolog",
          "Speciallärare/specialpedagog",
          "Skoladministratör",
          "Övrig arbetsledning",
          "Övrig pedagogisk personal",
          "Förskolechef"
        ]
      },
      "person": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "startDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "startDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "person"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "StartDateDesc",
          "StartDateAsc",
          "ModifiedDesc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "Duties",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /duties/lookup": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "person"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "IdLookup",
    "responses": {
      "200": "DutiesArray",
      "403": "Error",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /duties/{id}": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "person"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "DutyExpanded",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /groups": {
    "query": {
      "groupType": {
        "array": true,
        "type": "string",
        "enum": [
          "Undervisning",
          "Klass",
          "Mentor",
          "Provgrupp",
          "Schema",
          "Avdelning",
          "Personalgrupp",
          "Övrigt"
        ]
      },
      "schoolTypes": {
        "array": true,
        "type": "string",
        "enum": [
          "FS",
          "FKLASS",
          "FTH",
          "OPPFTH",
          "GR",
          "GRS",
          "TR",
          "SP",
          "SAM",
          "GY",
          "GYS",
          "VUX",
          "VUXSFI",
          "VUXGR",
          "VUXGY",
          "VUXSARGR",
          "VUXSARTR",
          "VUXSARGY",
          "SFI",
          "SARVUX",
          "SARVUXGR",
          "SARVUXGY",
          "KU",
          "YH",
          "FHS",
          "STF",
          "KKU",
          "HS",
          "ABU",
          "AU"
        ]
      },
      "organisation": {
        "array": true,
        "type": "string",
        "format": "uuid"
      },
      "startDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "startDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "assignmentRoles"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "ModifiedDesc",
          "DisplayNameAsc",
          "StartDateAsc",
          "StartDateDesc",
          "EndDateAsc",
          "EndDateDesc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "GroupsExpanded",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /groups/lookup": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "assignmentRoles"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "IdLookup",
    "responses": {
      "200": "GroupsExpandedArray",
      "403": "Error",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /groups/{id}": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "assignmentRoles"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "GroupExpanded",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /syllabuses": {
    "query": {
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "ModifiedDesc",
          "SubjectNameAsc",
          "SubjectNameDesc",
          "SubjectCodeAsc",
          "SubjectCodeDesc",
          "CourseNameAsc",
          "CourseNameDesc",
          "CourseCodeAsc",
          "CourseCodeDesc",
          "SubjectDesignationAsc",
          "SubjectDesignationDesc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "Syllabuses",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /syllabuses/lookup": {
    "query": {
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "IdLookup",
    "responses": {
      "200": "SyllabusesArray",
      "403": "Error",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /syllabuses/{id}": {
    "query": {
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "Syllabus",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /activities": {
    "query": {
      "member": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "teacher": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "organisation": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "group": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "startDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "startDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "endDate.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date"
      },
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "groups",
          "teachers",
          "syllabus"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "ModifiedDesc",
          "DisplayNameAsc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "Activities",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /activities/lookup": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "groups",
          "teachers",
          "syllabus"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "_activities_lookup_post_request",
    "responses": {
      "200": "ActivitiesArray",
      "403": "Error",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /activities/{id}": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "groups",
          "teachers",
          "syllabus"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "ActivityExpanded",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /calendarEvents": {
    "query": {
      "startTime.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date-time",
        "required": true
      },
      "startTime.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date-time",
        "required": true
      },
      "endTime.onOrBefore": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "endTime.onOrAfter": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "activity": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "student": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "teacher": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "organisation": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "group": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "activity",
          "attendance"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "ModifiedDesc",
          "StartTimeAsc",
          "StartTimeDesc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "CalendarEvents",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "GET /calendarEvents/{id}": {
    "query": {
      "expand": {
        "array": true,
        "type": "string",
        "enum": [
          "activity",
          "attendance"
        ]
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "CalendarEvent",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "POST /calendarEvents/lookup": {
    "query": {
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "_calendarEvents_lookup_post_request",
    "responses": {
      "200": "AttendancesArray",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /rooms": {
    "query": {
      "organisation": {
        "array": false,
        "type": "string",
        "format": "uuid"
      },
      "meta.created.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.created.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.before": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "meta.modified.after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      },
      "sortkey": {
        "array": false,
        "type": "string",
        "enum": [
          "ModifiedDesc",
          "DisplayNameAsc"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "Rooms",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /rooms/lookup": {
    "query": {
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": "IdLookup",
    "responses": {
      "200": "RoomsArray",
      "403": "Error",
      "503": "Error",
      "default": "Error"
    }
  },
  "GET /rooms/{id}": {
    "query": {
      "expandReferenceNames": {
        "array": false,
        "type": "boolean"
      }
    },
    "body": null,
    "responses": {
      "200": "Room",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /subscriptions": {
    "query": {
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "Subscriptions",
      "403": "Error",
      "default": "Error"
    }
  },
  "POST /subscriptions": {
    "query": {},
    "body": "CreateSubscription",
    "responses": {
      "201": "Subscription",
      "403": "Error",
      "default": "Error"
    }
  },
  "DELETE /subscriptions/{id}": {
    "query": {},
    "body": null,
    "responses": {
      "204": null,
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /subscriptions/{id}": {
    "query": {},
    "body": null,
    "responses": {
      "200": "Subscription",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "PATCH /subscriptions/{id}": {
    "query": {},
    "body": null,
    "responses": {
      "200": "Subscription",
      "400": "Error",
      "403": "Error",
      "404": null,
      "default": "Error"
    }
  },
  "GET /deletedEntities": {
    "query": {
      "after": {
        "array": false,
        "type": "string",
        "format": "date-time"
      },
      "entities": {
        "array": true,
        "type": "string",
        "enum": [
          "Absence",
          "AttendanceEvent",
          "Attendance",
          "Grade",
          "CalendarEvent",
          "AttendanceSchedule",
          "Resource",
          "Room",
          "Activity",
          "Duty",
          "Placement",
          "StudyPlan",
          "Programme",
          "Syllabus",
          "SchoolUnitOffering",
          "Group",
          "Person",
          "Organisation"
        ]
      },
      "limit": {
        "array": false,
        "type": "integer",
        "minimum": 1
      },
      "pageToken": {
        "array": false,
        "type": "string"
      }
    },
    "body": null,
    "responses": {
      "200": "DeletedEntities",
      "400": "Error",
      "403": "Error",
      "default": "Error"
    }
  }
};
