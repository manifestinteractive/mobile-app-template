var sqlite = {
	db: null,
	db_name: 'app_db',
	db_description: 'Application Database',
	db_size: (2 * 1024 * 1024),
	initialized: false,
	init: function(callback)
	{
		phonegap.stats.event('DB', 'Init', 'Initialize DB');

		sqlite.db = (typeof window.openDatabase !== 'undefined') ?
			window.openDatabase(sqlite.db_name, '', sqlite.db_description, sqlite.db_size) :
			window.sqlitePlugin.openDatabase(sqlite.db_name, '', sqlite.db_description, sqlite.db_size);

		if( !sqlite.db)
		{
			phonegap.notification.alert(
				'Unable to Create Locale Database',
				function(){},
				'Database Error',
				'OK'
			);

			return false;
		}
		else
		{
			var M = new Migrator(sqlite.db);
			M.setDebugLevel(Migrator.DEBUG_NONE);
			M.migration(1, function(tx){

				// Drop Certain Tables
				tx.executeSql("DROP TABLE IF EXISTS `app_settings`", [], sqlite.callback.success, sqlite.callback.error);

				// Create Tables
				tx.executeSql("CREATE TABLE `app_settings` ( `id` integer NOT NULL PRIMARY KEY AUTOINCREMENT, `device_id` text(100,0) NOT NULL ON CONFLICT REPLACE, `app_environment` text(25,0) NOT NULL DEFAULT 'production', `app_version` text(10,0) NOT NULL DEFAULT '0.5.0', `app_mode` text(10,0) NOT NULL DEFAULT 'training', `api_url_development` text(100,0) NOT NULL DEFAULT '', `api_url_staging` text(100,0) NOT NULL DEFAULT '', `api_url_production` text(100,0) NOT NULL DEFAULT '', `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, `last_modified` text, CONSTRAINT `device_id` UNIQUE (device_id) ON CONFLICT REPLACE )");
			});

			/**
			 * @TODO: if there are any DB migrations, change them like this:
			 *
			 * M.migration(2, function(tx){
			 * 	    tx.executeSql("ALTER TABLE item ADD COLUMN some_name TEXT");
			 * });
			 */

				// Start Migrations
			M.execute();

			M.whenDone(function(){
				sqlite.db.transaction(function(tx){

					if(typeof window.device !== 'undefined' && typeof window.settings !== 'undefined')
					{
						// Create Default Data
						tx.executeSql("INSERT INTO app_settings(app_environment, device_id, app_version) VALUES (?, ?, ?)",
							[
								window.settings.app.environment,
								window.device.uuid,
								window.settings.app.version
							],
							sqlite.callback.success,
							sqlite.callback.error
						);
					}
				});
			});

			if(typeof callback == 'function')
			{
				callback();
			}
		}
	},
	callback: {
		success: function(tx, results, callback)
		{
			var data = [];
			if(results.rows.length)
			{
				var len = results.rows.length, i;

				// If there is only one result, return it
				if(len == 1)
				{
					data = results.rows.item(0);
				}
				// otherwise return an array of results
				else
				{
					for (i = 0; i < len; i++)
					{
						data.push(results.rows.item(i));
					}
				}
			}
			else if(results)
			{
				data = {
					empty: true
				};

				try {
					data.insert_id = results.insertId;
				}
				catch(exc)
				{
					data.insert_id = null;
				}

				try {
					data.rows_affected = results.rowsAffected;
				}
				catch(exc)
				{
					data.rows_affected = null;
				}
			}

			if(typeof callback == 'function')
			{
				callback(data);
			}
		},
		error: function(err, callback)
		{
			if( !sqlite.initialized)
			{
				return false;
			}

			if(typeof err.message !== 'undefined')
			{
				phonegap.stats.event('App', 'DB Error', err.message);
				console.error(err.message);

				if(typeof Bugsnag !== 'undefined')
				{
					Bugsnag.notifyException(err, "FetchTeam");
				}
			}

			if(typeof callback == 'function')
			{
				callback({ error: err.message });
			}
		}
	},
	query: function(query, args, callback)
	{
		if( !query)
		{
			phonegap.util.debug('error', 'Missing Query Param');
			return false;
		}

		if( !args)
		{
			args = [];
		}

		sqlite.db.transaction(function(tx){
			tx.executeSql(
				query,
				args,
				function(tx, results)
				{
					sqlite.callback.success(tx, results, callback);
				},
				function(tx, err)
				{
					sqlite.callback.error(err, callback);
				}
			);
		});
	}
};

function Migrator(db){
	// Pending migrations to run
	var migrations = [];
	// Callbacks to run when migrations done
	var whenDone = [];

	var state = 0;

	var MIGRATOR_TABLE = "_migrator_schema";

	// Use this method to actually add a migration.
	// You'll probably want to start with 1 for the migration number.
	this.migration = function(number, func){
		migrations[number] = func;
	};

	// Execute a given migration by index
	var doMigration = function(number){
		if(migrations[number]){
			db.transaction(function(t){
				t.executeSql("update " + MIGRATOR_TABLE + " set version = ?", [number], function(t){
					debug(Migrator.DEBUG_HIGH, "Beginning migration %d", [number]);
					migrations[number](t);
					debug(Migrator.DEBUG_HIGH, "Completed migration %d", [number]);
					doMigration(number+1);
				}, function(t, err){
					error("Error!: %o (while upgrading to %s from %s)", err, number);
				})
			});
		} else {
			debug(Migrator.DEBUG_HIGH, "Migrations complete, executing callbacks.");
			state = 2;
			executeWhenDoneCallbacks();
		}
	};

	// helper that actually calls doMigration from doIt.
	var migrateStartingWith = function(ver){
		state = 1;
		debug(Migrator.DEBUG_LOW, "Main Migrator starting.");

		try {
			doMigration(ver+1);
		} catch(e) {
			error(e);
		}
	};

	this.execute = function(){
		if(state > 0){
			throw "Migrator is only valid once -- create a new one if you want to do another migration.";
		}
		db.transaction(function(t){
			t.executeSql("select version from " + MIGRATOR_TABLE, [], function(t, res){
				var rows = res.rows;
				var version = rows.item(0).version;
				debug(Migrator.DEBUG_HIGH, "Existing database present, migrating from %d", [version]);
				migrateStartingWith(version);
			}, function(t, err){
				if(err.message.match(/no such table/i)){
					t.executeSql("create table " + MIGRATOR_TABLE + "(version integer)", [], function(){
						t.executeSql("insert into " + MIGRATOR_TABLE + " values(0)", [], function(){
							debug(Migrator.DEBUG_HIGH, "New migration database created...");
							migrateStartingWith(0);
						}, function(t, err){
							error("Unrecoverable error inserting initial version into db: %o", err);
						});
					}, function(t, err){
						error("Unrecoverable error creating version table: %o", err);
					});
				} else {
					error("Unrecoverable error resolving schema version: %o", err);
				}
			});
		});

		return this;
	};

	// Called when the migration has completed.  If the migration has already completed,
	// executes immediately.  Otherwise, waits.
	this.whenDone = function(func){
		if(typeof func !== "array"){
			func = [func];
		}
		for(var f in func){
			whenDone.push(func[f]);
		}
		if(state > 1){
			debug(Migrator.DEBUG_LOW, "Executing 'whenDone' tasks immediately as the migrations have already finished.");
			executeWhenDoneCallbacks();
		}
	};

	var executeWhenDoneCallbacks = function(){
		for(var f in whenDone){
			whenDone[f]();
		}
		debug(Migrator.DEBUG_LOW, "Callbacks complete.");
		sqlite.initialized = true;
	};

	// Debugging stuff.
	var log = (window.console && console.log) ? function() { console.log.apply(console, argumentsToArray(arguments)) } : function(){};
	var error = (window.console && console.error) ? function() { console.error.apply(console, argumentsToArray(arguments)) } : function(){};

	var debugLevel = Migrator.DEBUG_NONE;

	var argumentsToArray = function(args) { return Array.prototype.slice.call(args); };
	this.setDebugLevel = function(level){
		debugLevel = level;
	};

	var debug = function(minLevel, message, args){
		if(debugLevel >= minLevel){
			var newArgs = [message];
			if(args != null) for(var i in args) newArgs.push(args[i]);

			log.apply(null, newArgs);
		}
	}
}

// no output, low threshold (lots of output), or high threshold (just log the weird stuff)
// these might be a little, uh, backwards
Migrator.DEBUG_NONE = 0;
Migrator.DEBUG_LOW = 1;
Migrator.DEBUG_HIGH = 2;