'use strict';
import { Pool, Client, types } from 'pg';
import { parse } from 'pgsql-ast-parser';
import { AntaresCore } from '../AntaresCore';
import dataTypes from 'common/data-types/postgresql';

function pgToString (value) {
   return value.toString();
}

types.setTypeParser(1082, pgToString); // date
types.setTypeParser(1083, pgToString); // time
types.setTypeParser(1114, pgToString); // timestamp
types.setTypeParser(1184, pgToString); // timestamptz
types.setTypeParser(1266, pgToString); // timetz

export class PostgreSQLClient extends AntaresCore {
   constructor (args) {
      super(args);

      this._schema = null;

      this.types = {};
      for (const key in types.builtins)
         this.types[types.builtins[key]] = key;

      this._arrayTypes = {
         _int2: 'SMALLINT',
         _int4: 'INTEGER',
         _int8: 'BIGINT',
         _float4: 'REAL',
         _float8: 'DOUBLE PRECISION',
         _char: '"CHAR"',
         _varchar: 'CHARACTER VARYING'
      };
   }

   _getTypeInfo (type) {
      return dataTypes
         .reduce((acc, group) => [...acc, ...group.types], [])
         .filter(_type => _type.name === type.toUpperCase())[0];
   }

   _getArrayType (type) {
      if (Object.keys(this._arrayTypes).includes(type))
         return this._arrayTypes[type];
      return type.replace('_', '');
   }

   /**
    * @memberof PostgreSQLClient
    */
   async connect () {
      if (!this._poolSize) {
         const client = new Client(this._params);
         await client.connect();
         this._connection = client;
      }
      else {
         const pool = new Pool({ ...this._params, max: this._poolSize });
         this._connection = pool;
      }
   }

   /**
    * @memberof PostgreSQLClient
    */
   destroy () {
      this._connection.end();
   }

   /**
    * Executes an USE query
    *
    * @param {String} schema
    * @memberof PostgreSQLClient
    */
   use (schema) {
      this._schema = schema;
      return this.raw(`SET search_path TO ${schema}`);
   }

   /**
    * @param {Array} schemas list
    * @returns {Array.<Object>} databases scructure
    * @memberof PostgreSQLClient
    */
   async getStructure (schemas) {
      const { rows: databases } = await this.raw('SELECT schema_name AS database FROM information_schema.schemata ORDER BY schema_name');
      const { rows: functions } = await this.raw('SELECT * FROM information_schema.routines WHERE routine_type = \'FUNCTION\'');
      const { rows: procedures } = await this.raw('SELECT * FROM information_schema.routines WHERE routine_type = \'PROCEDURE\'');

      const tablesArr = [];
      const triggersArr = [];

      for (const db of databases) {
         if (!schemas.has(db.database)) continue;

         let { rows: tables } = await this.raw(`
            SELECT *, 
               pg_table_size(QUOTE_IDENT(t.TABLE_SCHEMA) || '.' || QUOTE_IDENT(t.TABLE_NAME))::bigint AS data_length, 
               pg_relation_size(QUOTE_IDENT(t.TABLE_SCHEMA) || '.' || QUOTE_IDENT(t.TABLE_NAME))::bigint AS index_length, 
               c.reltuples, obj_description(c.oid) AS comment 
            FROM "information_schema"."tables" AS t 
            LEFT JOIN "pg_namespace" n ON t.table_schema = n.nspname 
            LEFT JOIN "pg_class" c ON n.oid = c.relnamespace AND c.relname=t.table_name 
            WHERE t."table_schema" = '${db.database}'
            ORDER BY table_name
         `);

         if (tables.length) {
            tables = tables.map(table => {
               table.Db = db.database;
               return table;
            });
            tablesArr.push(...tables);
         }

         let { rows: triggers } = await this.raw(`
            SELECT event_object_schema AS table_schema,
               event_object_table AS table_name,
               trigger_schema,
               trigger_name,
               string_agg(event_manipulation, ',') AS event,
               action_timing AS activation,
               action_condition AS condition,
               action_statement AS definition
            FROM information_schema.triggers
            WHERE trigger_schema = '${db.database}'
            GROUP BY 1,2,3,4,6,7,8
            ORDER BY table_schema,
                     table_name
         `);

         if (triggers.length) {
            triggers = triggers.map(trigger => {
               trigger.Db = db.database;
               return trigger;
            });
            triggersArr.push(...triggers);
         }
      }

      return databases.map(db => {
         if (schemas.has(db.database)) {
            // TABLES
            const remappedTables = tablesArr.filter(table => table.Db === db.database).map(table => {
               return {
                  name: table.table_name,
                  type: table.table_type === 'VIEW' ? 'view' : 'table',
                  rows: table.reltuples,
                  size: +table.data_length + +table.index_length,
                  collation: table.Collation,
                  comment: table.comment,
                  engine: ''
               };
            });

            // PROCEDURES
            const remappedProcedures = procedures.filter(procedure => procedure.routine_schema === db.database).map(procedure => {
               return {
                  name: procedure.routine_name,
                  type: procedure.routine_type,
                  security: procedure.security_type
               };
            });

            // FUNCTIONS
            const remappedFunctions = functions.filter(func => func.routine_schema === db.database && func.data_type !== 'trigger').map(func => {
               return {
                  name: func.routine_name,
                  type: func.routine_type,
                  security: func.security_type
               };
            });

            // TRIGGER FUNCTIONS
            const remappedTriggerFunctions = functions.filter(func => func.routine_schema === db.database && func.data_type === 'trigger').map(func => {
               return {
                  name: func.routine_name,
                  type: func.routine_type,
                  security: func.security_type
               };
            });

            // TRIGGERS
            const remappedTriggers = triggersArr.filter(trigger => trigger.Db === db.database).map(trigger => {
               return {
                  name: trigger.trigger_name,
                  timing: trigger.activation,
                  definer: trigger.definition, // ???
                  event: trigger.event,
                  table: trigger.table_trigger,
                  sqlMode: trigger.sql_mode
               };
            });

            return {
               name: db.database,
               tables: remappedTables,
               functions: remappedFunctions,
               procedures: remappedProcedures,
               triggers: remappedTriggers,
               triggerFunctions: remappedTriggerFunctions,
               schedulers: []
            };
         }
         else {
            return {
               name: db.database,
               tables: [],
               functions: [],
               procedures: [],
               triggers: [],
               schedulers: []
            };
         }
      });
   }

   /**
    * @param {Object} params
    * @param {String} params.schema
    * @param {String} params.table
    * @returns {Object} table scructure
    * @memberof PostgreSQLClient
    */
   async getTableColumns ({ schema, table }, arrayRemap = true) {
      const { rows } = await this
         .select('*')
         .schema('information_schema')
         .from('columns')
         .where({ table_schema: `= '${schema}'`, table_name: `= '${table}'` })
         .orderBy({ ordinal_position: 'ASC' })
         .run();

      return rows.map(field => {
         let type = field.data_type;
         const isArray = type === 'ARRAY';

         if (isArray && arrayRemap)
            type = this._getArrayType(field.udt_name);

         return {
            name: field.column_name,
            key: null,
            type: type.toUpperCase(),
            isArray,
            schema: field.table_schema,
            table: field.table_name,
            numPrecision: field.numeric_precision,
            datePrecision: field.datetime_precision,
            charLength: field.character_maximum_length,
            nullable: field.is_nullable.includes('YES'),
            unsigned: null,
            zerofill: null,
            order: field.ordinal_position,
            default: field.column_default,
            charset: field.character_set_name,
            collation: field.collation_name,
            autoIncrement: false,
            onUpdate: null,
            comment: ''
         };
      });
   }

   /**
    * @param {Object} params
    * @param {String} params.schema
    * @param {String} params.table
    * @returns {Object} table indexes
    * @memberof PostgreSQLClient
    */
   async getTableIndexes ({ schema, table }) {
      if (schema !== 'public')
         this.use(schema);

      const { rows } = await this.raw(`WITH ndx_list AS (
         SELECT pg_index.indexrelid, pg_class.oid
         FROM pg_index, pg_class
         WHERE pg_class.relname = '${table}' AND pg_class.oid = pg_index.indrelid), ndx_cols AS (
         SELECT pg_class.relname, UNNEST(i.indkey) AS col_ndx, CASE i.indisprimary WHEN TRUE THEN 'PRIMARY' ELSE CASE i.indisunique WHEN TRUE THEN 'UNIQUE' ELSE 'INDEX' END END AS CONSTRAINT_TYPE, pg_class.oid
         FROM pg_class
         JOIN pg_index i ON (pg_class.oid = i.indexrelid)
         JOIN ndx_list ON (pg_class.oid = ndx_list.indexrelid)
         WHERE pg_table_is_visible(pg_class.oid))
         SELECT ndx_cols.relname AS CONSTRAINT_NAME, ndx_cols.CONSTRAINT_TYPE, a.attname AS COLUMN_NAME
         FROM pg_attribute a
         JOIN ndx_cols ON (a.attnum = ndx_cols.col_ndx)
         JOIN ndx_list ON (ndx_list.oid = a.attrelid AND ndx_list.indexrelid = ndx_cols.oid)
      `);

      return rows.map(row => {
         return {
            name: row.constraint_name,
            column: row.column_name,
            indexType: null,
            type: row.constraint_type,
            cardinality: null,
            comment: '',
            indexComment: ''
         };
      });
   }

   /**
    *
    * @param {Number} id
    * @returns {Array}
    */
   async getTableByIDs (ids) {
      if (!ids) return;

      const { rows } = await this.raw(`
         SELECT relid AS tableid, relname, schemaname FROM pg_statio_all_tables WHERE relid IN (${ids}) 
         UNION
         SELECT pg_class.oid AS tableid,relname, nspname AS schemaname FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace WHERE pg_class.oid IN (${ids})
      `);

      return rows.reduce((acc, curr) => {
         acc[curr.tableid] = {
            table: curr.relname,
            schema: curr.schemaname
         };
         return acc;
      }, {});
   }

   /**
    * @param {Object} params
    * @param {String} params.schema
    * @param {String} params.table
    * @returns {Object} table key usage
    * @memberof PostgreSQLClient
    */
   async getKeyUsage ({ schema, table }) {
      const { rows } = await this.raw(`
         SELECT 
            tc.table_schema, 
            tc.constraint_name, 
            tc.table_name, 
            kcu.column_name, 
            kcu.position_in_unique_constraint, 
            kcu.ordinal_position, 
            ccu.table_schema AS foreign_table_schema,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            rc.update_rule,
            rc.delete_rule
         FROM information_schema.table_constraints AS tc 
         JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
         JOIN information_schema.referential_constraints AS rc 
            ON rc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${schema}'
         AND tc.table_name = '${table}'
      `);

      return rows.map(field => {
         return {
            schema: field.table_schema,
            table: field.table_name,
            field: field.column_name,
            position: field.ordinal_position,
            constraintPosition: field.position_in_unique_constraint,
            constraintName: field.constraint_name,
            refSchema: field.foreign_table_schema,
            refTable: field.foreign_table_name,
            refField: field.foreign_column_name,
            onUpdate: field.update_rule,
            onDelete: field.delete_rule
         };
      });
   }

   /**
    * SELECT *  FROM pg_catalog.pg_user
    *
    * @returns {Array.<Object>} users list
    * @memberof PostgreSQLClient
    */
   async getUsers () {
      const { rows } = await this.raw('SELECT *  FROM pg_catalog.pg_user');

      return rows.map(row => {
         return {
            name: row.username,
            host: row.host,
            password: row.passwd
         };
      });
   }

   /**
    * CREATE SCHEMA
    *
    * @returns {Array.<Object>} parameters
    * @memberof MySQLClient
    */
   async createSchema (params) {
      return await this.raw(`CREATE SCHEMA "${params.name}"`);
   }

   /**
    * ALTER DATABASE
    *
    * @returns {Array.<Object>} parameters
    * @memberof MySQLClient
    */
   async alterSchema (params) {
      return await this.raw(`ALTER SCHEMA "${params.name}"`);
   }

   /**
    * DROP DATABASE
    *
    * @returns {Array.<Object>} parameters
    * @memberof MySQLClient
    */
   async dropSchema (params) {
      return await this.raw(`DROP SCHEMA "${params.database}"`);
   }

   /**
    * SHOW CREATE VIEW
    *
    * @returns {Array.<Object>} view informations
    * @memberof PostgreSQLClient
    */
   async getViewInformations ({ schema, view }) {
      const sql = `SELECT "definition" FROM "pg_views" WHERE "viewname"='${view}' AND "schemaname"='${schema}'`;
      const results = await this.raw(sql);

      return results.rows.map(row => {
         return {
            algorithm: '',
            definer: '',
            security: '',
            updateOption: '',
            sql: row.definition,
            name: view
         };
      })[0];
   }

   /**
    * DROP VIEW
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async dropView (params) {
      const sql = `DROP VIEW ${this._schema}.${params.view}`;
      return await this.raw(sql);
   }

   /**
    * ALTER VIEW
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async alterView (params) {
      const { view } = params;
      let sql = `CREATE OR REPLACE VIEW ${this._schema}.${view.oldName} AS ${view.sql}`;

      if (view.name !== view.oldName)
         sql += `; ALTER VIEW ${this._schema}.${view.oldName} RENAME TO ${view.name}`;

      return await this.raw(sql);
   }

   /**
    * CREATE VIEW
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async createView (view) {
      const sql = `CREATE VIEW ${this._schema}.${view.name} AS ${view.sql}`;
      return await this.raw(sql);
   }

   /**
    * SHOW CREATE TRIGGER
    *
    * @returns {Array.<Object>} view informations
    * @memberof PostgreSQLClient
    */
   async getTriggerInformations ({ schema, trigger }) {
      const sql = `SHOW CREATE TRIGGER \`${schema}\`.\`${trigger}\``;
      const results = await this.raw(sql);

      return results.rows.map(row => {
         return {
            definer: row['SQL Original Statement'].match(/(?<=DEFINER=).*?(?=\s)/gs)[0],
            sql: row['SQL Original Statement'].match(/(BEGIN|begin)(.*)(END|end)/gs)[0],
            name: row.Trigger,
            table: row['SQL Original Statement'].match(/(?<=ON `).*?(?=`)/gs)[0],
            event1: row['SQL Original Statement'].match(/(BEFORE|AFTER)/gs)[0],
            event2: row['SQL Original Statement'].match(/(INSERT|UPDATE|DELETE)/gs)[0]
         };
      })[0];
   }

   /**
    * DROP TRIGGER
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async dropTrigger (params) {
      const sql = `DROP TRIGGER \`${params.trigger}\``;
      return await this.raw(sql);
   }

   /**
    * ALTER TRIGGER
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async alterTrigger (params) {
      const { trigger } = params;
      const tempTrigger = Object.assign({}, trigger);
      tempTrigger.name = `Antares_${tempTrigger.name}_tmp`;

      try {
         await this.createTrigger(tempTrigger);
         await this.dropTrigger({ trigger: tempTrigger.name });
         await this.dropTrigger({ trigger: trigger.oldName });
         await this.createTrigger(trigger);
      }
      catch (err) {
         return Promise.reject(err);
      }
   }

   /**
    * CREATE TRIGGER
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async createTrigger (trigger) {
      const sql = `CREATE ${trigger.definer ? `DEFINER=${trigger.definer} ` : ''}TRIGGER \`${trigger.name}\` ${trigger.event1} ${trigger.event2} ON \`${trigger.table}\` FOR EACH ROW ${trigger.sql}`;
      return await this.raw(sql, { split: false });
   }

   /**
    * SHOW CREATE PROCEDURE
    *
    * @returns {Array.<Object>} view informations
    * @memberof PostgreSQLClient
    */
   async getRoutineInformations ({ schema, routine }) {
      const sql = `SELECT pg_get_functiondef((SELECT oid FROM pg_proc WHERE proname = '${routine}'));`;
      const results = await this.raw(sql);

      return results.rows.map(async row => {
         if (!row.pg_get_functiondef) {
            return {
               definer: null,
               sql: '',
               parameters: [],
               name: routine,
               comment: '',
               security: 'DEFINER',
               deterministic: false,
               dataAccess: 'CONTAINS SQL'
            };
         }

         const sql = `SELECT proc.specific_schema AS procedure_schema,
               proc.specific_name,
               proc.routine_name AS procedure_name,
               proc.external_language,
               args.parameter_name,
               args.parameter_mode,
               args.data_type
            FROM information_schema.routines proc
            LEFT JOIN information_schema.parameters args
               ON proc.specific_schema = args.specific_schema
               AND proc.specific_name = args.specific_name
            WHERE proc.routine_schema not in ('pg_catalog', 'information_schema')
               AND proc.routine_type = 'PROCEDURE'
               AND proc.routine_name = '${routine}'
               AND proc.specific_schema = '${schema}'
            ORDER BY procedure_schema,
               specific_name,
               procedure_name,
               args.ordinal_position
           `;

         const results = await this.raw(sql);

         const parameters = results.rows.map(row => {
            return {
               name: row.parameter_name,
               type: row.data_type.toUpperCase(),
               length: '',
               context: row.parameter_mode
            };
         });

         return {
            definer: '',
            sql: row.pg_get_functiondef.match(/(\$(.*)\$)(.*)(\$(.*)\$)/gs)[0],
            parameters: parameters || [],
            name: routine,
            comment: '',
            security: row.pg_get_functiondef.includes('SECURITY DEFINER') ? 'DEFINER' : 'INVOKER',
            deterministic: null,
            dataAccess: null,
            language: row.pg_get_functiondef.match(/(?<=LANGUAGE )(.*)(?<=[\S+\n\r\s])/gm)[0]
         };
      })[0];
   }

   /**
    * DROP PROCEDURE
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async dropRoutine (params) {
      const sql = `DROP PROCEDURE ${this._schema}.${params.routine}`;
      return await this.raw(sql);
   }

   /**
    * ALTER PROCEDURE
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async alterRoutine (params) {
      const { routine } = params;
      const tempProcedure = Object.assign({}, routine);
      tempProcedure.name = `Antares_${tempProcedure.name}_tmp`;

      try {
         await this.createRoutine(tempProcedure);
         await this.dropRoutine({ routine: tempProcedure.name });
         await this.dropRoutine({ routine: routine.oldName });
         await this.createRoutine(routine);
      }
      catch (err) {
         return Promise.reject(err);
      }
   }

   /**
    * CREATE PROCEDURE
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async createRoutine (routine) {
      const parameters = 'parameters' in routine
         ? routine.parameters.reduce((acc, curr) => {
            acc.push(`${curr.context} ${curr.name} ${curr.type}${curr.length ? `(${curr.length})` : ''}`);
            return acc;
         }, []).join(',')
         : '';

      if (this._schema !== 'public')
         this.use(this._schema);

      const sql = `CREATE PROCEDURE ${this._schema}.${routine.name}(${parameters})
         LANGUAGE ${routine.language}
         SECURITY ${routine.security}
         AS ${routine.sql}`;

      return await this.raw(sql, { split: false });
   }

   /**
    * SHOW CREATE FUNCTION
    *
    * @returns {Array.<Object>} view informations
    * @memberof PostgreSQLClient
    */
   async getFunctionInformations ({ schema, func }) {
      const sql = `SELECT pg_get_functiondef((SELECT oid FROM pg_proc WHERE proname = '${func}'));`;
      const results = await this.raw(sql);

      return results.rows.map(async row => {
         if (!row.pg_get_functiondef) {
            return {
               definer: null,
               sql: '',
               parameters: [],
               name: func,
               comment: '',
               security: 'DEFINER',
               deterministic: false,
               dataAccess: 'CONTAINS SQL'
            };
         }

         const sql = `SELECT proc.specific_schema AS procedure_schema,
                  proc.specific_name,
                  proc.routine_name AS procedure_name,
                  proc.external_language,
                  args.parameter_name,
                  args.parameter_mode,
                  args.data_type
               FROM information_schema.routines proc
               LEFT JOIN information_schema.parameters args
                  ON proc.specific_schema = args.specific_schema
                  AND proc.specific_name = args.specific_name
               WHERE proc.routine_schema not in ('pg_catalog', 'information_schema')
                  AND proc.routine_type = 'FUNCTION'
                  AND proc.routine_name = '${func}'
                  AND proc.specific_schema = '${schema}'
               ORDER BY procedure_schema,
                  specific_name,
                  procedure_name,
                  args.ordinal_position
              `;

         const results = await this.raw(sql);

         const parameters = results.rows.map(row => {
            return {
               name: row.parameter_name,
               type: row.data_type.toUpperCase(),
               length: '',
               context: row.parameter_mode
            };
         });

         return {
            definer: '',
            sql: row.pg_get_functiondef.match(/(\$(.*)\$)(.*)(\$(.*)\$)/gs)[0],
            parameters: parameters || [],
            name: func,
            comment: '',
            security: row.pg_get_functiondef.includes('SECURITY DEFINER') ? 'DEFINER' : 'INVOKER',
            deterministic: null,
            dataAccess: null,
            language: row.pg_get_functiondef.match(/(?<=LANGUAGE )(.*)(?<=[\S+\n\r\s])/gm)[0],
            returns: row.pg_get_functiondef.match(/(?<=RETURNS SETOF )(.*)(?<=[\S+\n\r\s])/gm)[0].toUpperCase()
         };
      })[0];
   }

   /**
    * DROP FUNCTION
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async dropFunction (params) {
      const sql = `DROP FUNCTION \`${params.func}\``;
      return await this.raw(sql);
   }

   /**
    * ALTER FUNCTION
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async alterFunction (params) {
      const { func } = params;
      const tempProcedure = Object.assign({}, func);
      tempProcedure.name = `Antares_${tempProcedure.name}_tmp`;

      try {
         await this.createFunction(tempProcedure);
         await this.dropFunction({ func: tempProcedure.name });
         await this.dropFunction({ func: func.oldName });
         await this.createFunction(func);
      }
      catch (err) {
         return Promise.reject(err);
      }
   }

   /**
    * CREATE FUNCTION
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async createFunction (func) {
      const parameters = func.parameters.reduce((acc, curr) => {
         acc.push(`\`${curr.name}\` ${curr.type}${curr.length ? `(${curr.length})` : ''}`);
         return acc;
      }, []).join(',');

      const sql = `CREATE ${func.definer ? `DEFINER=${func.definer} ` : ''}FUNCTION \`${func.name}\`(${parameters}) RETURNS ${func.returns}${func.returnsLength ? `(${func.returnsLength})` : ''}
         LANGUAGE ${func.language}
         ${func.deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC'}
         ${func.dataAccess}
         SQL SECURITY ${func.security}
         COMMENT '${func.comment}'
         ${func.sql}`;

      return await this.raw(sql, { split: false });
   }

   /**
    * SHOW CREATE EVENT
    *
    * @returns {Array.<Object>} view informations
    * @memberof PostgreSQLClient
    */
   // async getEventInformations ({ schema, scheduler }) {
   //    const sql = `SHOW CREATE EVENT \`${schema}\`.\`${scheduler}\``;
   //    const results = await this.raw(sql);

   //    return results.rows.map(row => {
   //       const schedule = row['Create Event'];
   //       const execution = schedule.includes('EVERY') ? 'EVERY' : 'ONCE';
   //       const every = execution === 'EVERY' ? row['Create Event'].match(/(?<=EVERY )(\s*([^\s]+)){0,2}/gs)[0].replaceAll('\'', '').split(' ') : [];
   //       const starts = execution === 'EVERY' && schedule.includes('STARTS') ? schedule.match(/(?<=STARTS ').*?(?='\s)/gs)[0] : '';
   //       const ends = execution === 'EVERY' && schedule.includes('ENDS') ? schedule.match(/(?<=ENDS ').*?(?='\s)/gs)[0] : '';
   //       const at = execution === 'ONCE' && schedule.includes('AT') ? schedule.match(/(?<=AT ').*?(?='\s)/gs)[0] : '';

   //       return {
   //          definer: row['Create Event'].match(/(?<=DEFINER=).*?(?=\s)/gs)[0],
   //          sql: row['Create Event'].match(/(?<=DO )(.*)/gs)[0],
   //          name: row.Event,
   //          comment: row['Create Event'].match(/(?<=COMMENT ').*?(?=')/gs) ? row['Create Event'].match(/(?<=COMMENT ').*?(?=')/gs)[0] : '',
   //          state: row['Create Event'].includes('ENABLE') ? 'ENABLE' : row['Create Event'].includes('DISABLE ON SLAVE') ? 'DISABLE ON SLAVE' : 'DISABLE',
   //          preserve: row['Create Event'].includes('ON COMPLETION PRESERVE'),
   //          execution,
   //          every,
   //          starts,
   //          ends,
   //          at
   //       };
   //    })[0];
   // }

   /**
    * DROP EVENT
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   // async dropEvent (params) {
   //    const sql = `DROP EVENT \`${params.scheduler}\``;
   //    return await this.raw(sql);
   // }

   /**
    * ALTER EVENT
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   // async alterEvent (params) {
   //    const { scheduler } = params;

   //    if (scheduler.execution === 'EVERY' && scheduler.every[0].includes('-'))
   //       scheduler.every[0] = `'${scheduler.every[0]}'`;

   //    const sql = `ALTER ${scheduler.definer ? ` DEFINER=${scheduler.definer}` : ''} EVENT \`${scheduler.oldName}\`
   //    ON SCHEDULE
   //       ${scheduler.execution === 'EVERY'
   //    ? `EVERY ${scheduler.every.join(' ')}${scheduler.starts ? ` STARTS '${scheduler.starts}'` : ''}${scheduler.ends ? ` ENDS '${scheduler.ends}'` : ''}`
   //    : `AT '${scheduler.at}'`}
   //    ON COMPLETION${!scheduler.preserve ? ' NOT' : ''} PRESERVE
   //    ${scheduler.name !== scheduler.oldName ? `RENAME TO \`${scheduler.name}\`` : ''}
   //    ${scheduler.state}
   //    COMMENT '${scheduler.comment}'
   //    DO ${scheduler.sql}`;

   //    return await this.raw(sql, { split: false });
   // }

   /**
    * CREATE EVENT
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   // async createEvent (scheduler) {
   //    const sql = `CREATE ${scheduler.definer ? ` DEFINER=${scheduler.definer}` : ''} EVENT \`${scheduler.name}\`
   //    ON SCHEDULE
   //       ${scheduler.execution === 'EVERY'
   //    ? `EVERY ${scheduler.every.join(' ')}${scheduler.starts ? ` STARTS '${scheduler.starts}'` : ''}${scheduler.ends ? ` ENDS '${scheduler.ends}'` : ''}`
   //    : `AT '${scheduler.at}'`}
   //    ON COMPLETION${!scheduler.preserve ? ' NOT' : ''} PRESERVE
   //    ${scheduler.state}
   //    COMMENT '${scheduler.comment}'
   //    DO ${scheduler.sql}`;

   //    return await this.raw(sql, { split: false });
   // }

   /**
    * SELECT * FROM pg_collation
    *
    * @returns {Array.<Object>} collations list
    * @memberof PostgreSQLClient
    */
   async getCollations () {
      return [];
   }

   /**
    * SHOW ALL
    *
    * @returns {Array.<Object>} variables list
    * @memberof PostgreSQLClient
    */
   async getVariables () {
      const sql = 'SHOW ALL';
      const results = await this.raw(sql);

      return results.rows.map(row => {
         return {
            name: row.name,
            value: row.setting
         };
      });
   }

   /**
    * SHOW ENGINES
    *
    * @returns {Array.<Object>} engines list
    * @memberof PostgreSQLClient
    */
   async getEngines () {
      return {
         name: 'PostgreSQL',
         support: 'YES',
         comment: '',
         isDefault: true
      };
   }

   /**
    * SHOW VARIABLES LIKE '%vers%'
    *
    * @returns {Array.<Object>} version parameters
    * @memberof PostgreSQLClient
    */
   async getVersion () {
      const sql = 'SELECT version()';
      const { rows } = await this.raw(sql);
      const infos = rows[0].version.split(',');

      return {
         number: infos[0].split(' ')[1],
         name: infos[0].split(' ')[0],
         arch: infos[1],
         os: infos[2]
      };
   }

   async getProcesses () {
      const sql = 'SELECT "pid", "usename", "client_addr", "datname", application_name , EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - "query_start")::INTEGER, "state", "query" FROM "pg_stat_activity"';

      const { rows } = await this.raw(sql);

      return rows.map(row => {
         return {
            id: row.pid,
            user: row.usename,
            host: row.client_addr,
            database: row.datname,
            application: row.application_name,
            time: row.date_part,
            state: row.state,
            info: row.query
         };
      });
   }

   /**
    * CREATE TABLE
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async createTable (params) {
      const {
         name
      } = params;

      const sql = `CREATE TABLE ${this._schema}.${name} (${name}_id INTEGER NULL); ALTER TABLE ${this._schema}.${name} DROP COLUMN ${name}_id`;

      return await this.raw(sql);
   }

   /**
    * ALTER TABLE
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async alterTable (params) {
      const {
         table,
         additions,
         deletions,
         changes,
         indexChanges,
         foreignChanges,
         options
      } = params;

      let sql = '';
      const alterColumns = [];
      const renameColumns = [];
      const createSequences = [];
      const manageIndexes = [];

      // OPTIONS
      if ('comment' in options) alterColumns.push(`COMMENT='${options.comment}'`);
      if ('engine' in options) alterColumns.push(`ENGINE=${options.engine}`);
      if ('autoIncrement' in options) alterColumns.push(`AUTO_INCREMENT=${+options.autoIncrement}`);
      if ('collation' in options) alterColumns.push(`COLLATE='${options.collation}'`);

      // ADD FIELDS
      additions.forEach(addition => {
         const typeInfo = this._getTypeInfo(addition.type);
         const length = typeInfo.length ? addition.numLength || addition.charLength || addition.datePrecision : false;

         alterColumns.push(`ADD COLUMN ${addition.name} 
            ${addition.type.toUpperCase()}${length ? `(${length})` : ''}${addition.isArray ? '[]' : ''}
            ${addition.unsigned ? 'UNSIGNED' : ''} 
            ${addition.zerofill ? 'ZEROFILL' : ''}
            ${addition.nullable ? 'NULL' : 'NOT NULL'}
            ${addition.autoIncrement ? 'AUTO_INCREMENT' : ''}
            ${addition.default ? `DEFAULT ${addition.default}` : ''}
            ${addition.comment ? `COMMENT '${addition.comment}'` : ''}
            ${addition.collation ? `COLLATE ${addition.collation}` : ''}
            ${addition.onUpdate ? `ON UPDATE ${addition.onUpdate}` : ''}`);
      });

      // ADD INDEX
      indexChanges.additions.forEach(addition => {
         const fields = addition.fields.map(field => `${field}`).join(',');
         const type = addition.type;

         if (type === 'PRIMARY')
            alterColumns.push(`ADD PRIMARY KEY (${fields})`);
         else if (type === 'UNIQUE')
            alterColumns.push(`ADD CONSTRAINT ${addition.name} UNIQUE (${fields})`);
         else
            manageIndexes.push(`CREATE INDEX ${addition.name} ON ${table}(${fields})`);
      });

      // ADD FOREIGN KEYS
      foreignChanges.additions.forEach(addition => {
         alterColumns.push(`ADD CONSTRAINT ${addition.constraintName} FOREIGN KEY (${addition.field}) REFERENCES ${addition.refTable} (${addition.refField}) ON UPDATE ${addition.onUpdate} ON DELETE ${addition.onDelete}`);
      });

      // CHANGE FIELDS
      changes.forEach(change => {
         const typeInfo = this._getTypeInfo(change.type);
         const length = typeInfo.length ? change.numLength || change.charLength || change.datePrecision : false;
         let localType;

         switch (change.type) {
            case 'SERIAL':
               localType = 'integer';
               break;
            case 'SMALLSERIAL':
               localType = 'smallint';
               break;
            case 'BIGSERIAL':
               localType = 'bigint';
               break;
            default:
               localType = change.type.toLowerCase();
         }

         alterColumns.push(`ALTER COLUMN "${change.orgName}" TYPE ${localType}${length ? `(${length})` : ''}${change.isArray ? '[]' : ''} USING "${change.orgName}"::${localType}`);
         alterColumns.push(`ALTER COLUMN "${change.orgName}" ${change.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
         alterColumns.push(`ALTER COLUMN "${change.orgName}" ${change.default ? `SET DEFAULT ${change.default}` : 'DROP DEFAULT'}`);
         if (['SERIAL', 'SMALLSERIAL', 'BIGSERIAL'].includes(change.type)) {
            const sequenceName = `${table}_${change.name}_seq`.replace(' ', '_');
            createSequences.push(`CREATE SEQUENCE IF NOT EXISTS ${sequenceName} OWNED BY "${table}"."${change.orgName}"`);
            alterColumns.push(`ALTER COLUMN "${change.orgName}" SET DEFAULT nextval('${sequenceName}')`);
         }

         if (change.orgName !== change.name)
            renameColumns.push(`ALTER TABLE "${this._schema}"."${table}" RENAME COLUMN "${change.orgName}" TO "${change.name}"`);
      });

      // CHANGE INDEX
      indexChanges.changes.forEach(change => {
         if (change.oldType === 'PRIMARY')
            alterColumns.push('DROP PRIMARY KEY');
         else if (change.oldType === 'UNIQUE')
            alterColumns.push(`DROP CONSTRAINT ${change.oldName}`);
         else
            manageIndexes.push(`DROP INDEX ${change.oldName}`);

         const fields = change.fields.map(field => `${field}`).join(',');
         const type = change.type;

         if (type === 'PRIMARY')
            alterColumns.push(`ADD PRIMARY KEY (${fields})`);
         else if (type === 'UNIQUE')
            alterColumns.push(`ADD CONSTRAINT ${change.name} UNIQUE (${fields})`);
         else
            manageIndexes.push(`CREATE INDEX ${change.name} ON ${table}(${fields})`);
      });

      // CHANGE FOREIGN KEYS
      foreignChanges.changes.forEach(change => {
         alterColumns.push(`DROP CONSTRAINT ${change.oldName}`);
         alterColumns.push(`ADD CONSTRAINT ${change.constraintName} FOREIGN KEY (${change.field}) REFERENCES ${change.refTable} (${change.refField}) ON UPDATE ${change.onUpdate} ON DELETE ${change.onDelete}`);
      });

      // DROP FIELDS
      deletions.forEach(deletion => {
         alterColumns.push(`DROP COLUMN ${deletion.name}`);
      });

      // DROP INDEX
      indexChanges.deletions.forEach(deletion => {
         if (['PRIMARY', 'UNIQUE'].includes(deletion.type))
            alterColumns.push(`DROP CONSTRAINT ${deletion.name}`);
         else
            manageIndexes.push(`DROP INDEX ${deletion.name}`);
      });

      // DROP FOREIGN KEYS
      foreignChanges.deletions.forEach(deletion => {
         alterColumns.push(`DROP CONSTRAINT ${deletion.constraintName}`);
      });

      if (alterColumns.length) sql += `ALTER TABLE "${this._schema}"."${table}" ${alterColumns.join(', ')}; `;

      // RENAME
      if (renameColumns.length) sql += `${renameColumns.join(';')}; `;
      if (createSequences.length) sql = `${createSequences.join(';')}; ${sql}`;
      if (manageIndexes.length) sql = `${manageIndexes.join(';')}; ${sql}`;
      if (options.name) sql += `ALTER TABLE "${this._schema}"."${table}" RENAME TO "${options.name}"; `;

      return await this.raw(sql);
   }

   /**
    * TRUNCATE TABLE
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async truncateTable (params) {
      const sql = `TRUNCATE TABLE ${this._schema}.${params.table}`;
      return await this.raw(sql);
   }

   /**
    * DROP TABLE
    *
    * @returns {Array.<Object>} parameters
    * @memberof PostgreSQLClient
    */
   async dropTable (params) {
      const sql = `DROP TABLE ${this._schema}.${params.table}`;
      return await this.raw(sql);
   }

   /**
    * @returns {String} SQL string
    * @memberof PostgreSQLClient
    */
   getSQL () {
      // SELECT
      const selectArray = this._query.select.reduce(this._reducer, []);
      let selectRaw = '';

      if (selectArray.length)
         selectRaw = selectArray.length ? `SELECT ${selectArray.join(', ')} ` : 'SELECT * ';

      // FROM
      let fromRaw = '';

      if (!this._query.update.length && !Object.keys(this._query.insert).length && !!this._query.from)
         fromRaw = 'FROM';
      else if (Object.keys(this._query.insert).length)
         fromRaw = 'INTO';

      fromRaw += this._query.from ? ` ${this._query.schema ? `${this._query.schema}.` : ''}${this._query.from} ` : '';

      // WHERE
      const whereArray = this._query.where.reduce(this._reducer, []);
      const whereRaw = whereArray.length ? `WHERE ${whereArray.join(' AND ')} ` : '';

      // UPDATE
      const updateArray = this._query.update.reduce(this._reducer, []);
      const updateRaw = updateArray.length ? `SET ${updateArray.join(', ')} ` : '';

      // INSERT
      let insertRaw = '';

      if (this._query.insert.length) {
         const fieldsList = Object.keys(this._query.insert[0]).map(f => `"${f}"`);
         const rowsList = this._query.insert.map(el => `(${Object.values(el).join(', ')})`);

         insertRaw = `(${fieldsList.join(', ')}) VALUES ${rowsList.join(', ')} `;
      }

      // GROUP BY
      const groupByArray = this._query.groupBy.reduce(this._reducer, []);
      const groupByRaw = groupByArray.length ? `GROUP BY ${groupByArray.join(', ')} ` : '';

      // ORDER BY
      const orderByArray = this._query.orderBy.reduce(this._reducer, []);
      const orderByRaw = orderByArray.length ? `ORDER BY ${orderByArray.join(', ')} ` : '';

      // LIMIT
      const limitRaw = selectArray.length && this._query.limit.length ? `LIMIT ${this._query.limit.join(', ')} ` : '';

      return `${selectRaw}${updateRaw ? 'UPDATE' : ''}${insertRaw ? 'INSERT ' : ''}${this._query.delete ? 'DELETE ' : ''}${fromRaw}${updateRaw}${whereRaw}${groupByRaw}${orderByRaw}${limitRaw}${insertRaw}`;
   }

   /**
    * @param {string} sql raw SQL query
    * @param {object} args
    * @param {boolean} args.nest
    * @param {boolean} args.details
    * @param {boolean} args.split
    * @returns {Promise}
    * @memberof PostgreSQLClient
    */
   async raw (sql, args) {
      args = {
         nest: false,
         details: false,
         split: true,
         ...args
      };

      if (args.nest && this._schema !== 'public')
         this.use(this._schema);

      const resultsArr = [];
      let paramsArr = [];
      const queries = args.split ? sql.split(';') : [sql];

      if (process.env.NODE_ENV === 'development') this._logger(sql);// TODO: replace BLOB content with a placeholder

      for (const query of queries) {
         if (!query) continue;

         const timeStart = new Date();
         let timeStop;
         let keysArr = [];

         const { rows, report, fields, keys, duration } = await new Promise((resolve, reject) => {
            this._connection.query({
               rowMode: args.nest ? 'array' : null,
               text: query
            }, async (err, res) => {
               timeStop = new Date();

               if (err)
                  reject(err);
               else {
                  let ast;

                  try {
                     [ast] = parse(query);
                  }
                  catch (err) {}

                  const { rows, fields } = res;
                  let queryResult;
                  let tablesInfo;

                  if (args.nest) {
                     const tablesID = [...new Set(fields.map(field => field.tableID))].toString();
                     tablesInfo = await this.getTableByIDs(tablesID);

                     queryResult = rows.map(row => {
                        return row.reduce((acc, curr, i) => {
                           const table = tablesInfo[fields[i].tableID] ? tablesInfo[fields[i].tableID].table : '';
                           acc[`${table ? `${table}.` : ''}${fields[i].name}`] = curr;
                           return acc;
                        }, {});
                     });
                  }
                  else
                     queryResult = rows;

                  let remappedFields = fields
                     ? fields.map(field => {
                        if (!field || Array.isArray(field))
                           return false;

                        let schema = ast && ast.from && 'schema' in ast.from[0] ? ast.from[0].schema : this._schema;
                        let table = ast && ast.from ? ast.from[0].name : null;

                        if (args.nest) {
                           schema = tablesInfo[field.tableID] ? tablesInfo[field.tableID].schema : this._schema;
                           table = tablesInfo[field.tableID] ? tablesInfo[field.tableID].table : null;
                        }

                        return {
                           ...field,
                           name: field.name,
                           alias: field.name,
                           schema,
                           table,
                           // TODO: pick ast.from index if multiple
                           tableAlias: ast && ast.from ? ast.from[0].as : null,
                           orgTable: ast && ast.from ? ast.from[0].name : null,
                           type: this.types[field.dataTypeID] || field.format
                        };
                     }).filter(Boolean)
                     : [];

                  if (args.details) {
                     if (remappedFields.length) {
                        paramsArr = remappedFields.map(field => {
                           return {
                              table: field.table,
                              schema: field.schema
                           };
                        }).filter((val, i, arr) => arr.findIndex(el => el.schema === val.schema && el.table === val.table) === i);

                        for (const paramObj of paramsArr) {
                           if (!paramObj.table || !paramObj.schema) continue;

                           try { // Column details
                              const columns = await this.getTableColumns(paramObj, false);
                              const indexes = await this.getTableIndexes(paramObj);

                              remappedFields = remappedFields.map(field => {
                                 const detailedField = columns.find(f => f.name === field.name);
                                 const fieldIndex = indexes.find(i => i.column === field.name);
                                 if (field.table === paramObj.table && field.schema === paramObj.schema) {
                                    if (detailedField) {
                                       const length = detailedField.numPrecision || detailedField.charLength || detailedField.datePrecision || null;
                                       field = { ...field, ...detailedField, length };
                                    }

                                    if (fieldIndex) {
                                       const key = fieldIndex.type === 'PRIMARY' ? 'pri' : fieldIndex.type === 'UNIQUE' ? 'uni' : 'mul';
                                       field = { ...field, key };
                                    };
                                 }

                                 return field;
                              });
                           }
                           catch (err) {
                              reject(err);
                           }

                           try { // Key usage (foreign keys)
                              const response = await this.getKeyUsage(paramObj);
                              keysArr = keysArr ? [...keysArr, ...response] : response;
                           }
                           catch (err) {
                              reject(err);
                           }
                        }
                     }
                  }

                  resolve({
                     duration: timeStop - timeStart,
                     rows: Array.isArray(queryResult) ? queryResult.some(el => Array.isArray(el)) ? [] : queryResult : false,
                     report: !Array.isArray(queryResult) ? queryResult : false,
                     fields: remappedFields,
                     keys: keysArr
                  });
               }
            });
         });

         resultsArr.push({ rows, report, fields, keys, duration });
      }

      return resultsArr.length === 1 ? resultsArr[0] : resultsArr;
   }
}
