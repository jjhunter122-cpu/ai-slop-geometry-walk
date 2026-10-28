import { Actor, Engine, Keys, Scene } from 'excalibur';
import {
  ASTEROID,
  ASTEROID_SPAWN,
  BOSS,
  BOSS_EVERY,
  BULLET,
  ENEMY_KINDS,
  ENEMY_SPAWN,
  FIELD,
  PLAYER,
  UPGRADE,
  VIEW,
} from '../config';
import { AsteroidActor } from '../entities/AsteroidActor';
import { BossActor } from '../entities/BossActor';
import { BulletActor } from '../entities/BulletActor';
import { EnemyActor } from '../entities/EnemyActor';
import { PlayerActor } from '../entities/PlayerActor';
import { ProjectileActor } from '../entities/ProjectileActor';
import { Starfield } from '../fx/Starfield';
import {
  isAsteroidGone,
  spawnAsteroid,
  stepAsteroid,
  type AsteroidState,
} from '../logic/asteroid';
import {
  damageBoss,
  isBossDead,
  spawnBoss,
  stepBoss,
  tickBossAttack,
  type BossState,
} from '../logic/boss';
import {
  fireVolley,
  isBulletSpent,
  stepBullet,
  type BulletState,
} from '../logic/bullet';
import {
  chooseEnemyKind,
  isEnemyGone,
  spawnEnemy,
  stepEnemy,
  type EnemyState,
} from '../logic/enemy';
import {
  boxCorners,
  circleBoxOverlap,
  enemyVertices,
  polygonsOverlap,
} from '../logic/shapes';
import {
  createPlayer,
  damagePlayer,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
} from '../logic/player';
import { overlaps } from '../logic/mathx';
import {
  aimedVolley,
  isProjectileSpent,
  stepProjectile,
  type ProjectileState,
} from '../logic/projectile';
import { Spawner } from '../logic/spawner';
import { nextUpgrade, upgradesFor, type Upgrade } from '../logic/upgrades';
import { Hud } from '../ui/Hud';

interface Rendered<TState> extends Actor {
  sync(state: TState): void;
}

interface Live<TState> {
  state: TState;
  actor: Rendered<TState>;
}

const TOAST_SECONDS = 2.5;

/**
 * The one and only gameplay scene: a forward-scrolling shoot 'em up.
 *
 * Simulation is delegated to the pure modules under `src/game/logic`, and this
 * scene is responsible for wiring input, rendering actors, scoring, the boss
 * cadence and the upgrade rewards.
 */
export class GameScene extends Scene {
  private player: PlayerState = createPlayer(
    PLAYER.startX,
    PLAYER.size,
    PLAYER.lives,
    FIELD,
  );
  private playerActor = new PlayerActor();
  private bullets: Live<BulletState>[] = [];
  private enemies: Live<EnemyState>[] = [];
  private asteroids: Live<AsteroidState>[] = [];
  private boss: Live<BossState> | null = null;
  private bossProjectiles: Live<ProjectileState>[] = [];
  private starfield!: Starfield;
  private hud!: Hud;
  private spawner = new Spawner(Math.random, ENEMY_SPAWN);
  private asteroidSpawner = new Spawner(Math.random, ASTEROID_SPAWN);
  private readonly upgradeList: Upgrade[] = upgradesFor(UPGRADE);

  private score = 0;
  private elapsed = 0;
  private gameOver = false;
  private nextBossAt = BOSS_EVERY;
  private bossCount = 0;
  private upgradesTaken = 0;
  private toastTimer = 0;

  onInitialize(_engine: Engine): void {
    this.starfield = new Starfield(this, VIEW.width, VIEW.height);
    this.hud = new Hud();

    this.add(this.playerActor);
    this.playerActor.sync(this.player);

    this.hud.setScore(this.score);
    this.hud.setLives(this.player.lives);
    this.hud.hideBoss();
    this.hud.hideToast();
    this.hud.hideMessage();
  }

  onPreUpdate(engine: Engine, elapsedMs: number): void {
    // Clamp the step so a background tab or a slow frame can't teleport actors.
    const dt = Math.min(elapsedMs / 1000, 1 / 30);
    this.starfield.update(dt);

    if (this.gameOver) {
      if (engine.input.keyboard.wasPressed(Keys.Enter)) {
        this.restart();
      }
      return;
    }

    this.elapsed += dt;
    this.tickToast(dt);

    stepPlayer(this.player, this.readInput(engine), dt, FIELD);
    this.playerActor.sync(this.player);

    this.tryFire();
    this.stepBullets(dt);

    if (this.boss) {
      this.stepBossFight(dt);
    } else {
      // Ordinary enemies and asteroids hold off while a boss is on screen.
      this.spawnEnemies(dt);
      this.spawnAsteroids(dt);
    }
    this.stepEnemies(dt);
    this.stepAsteroids(dt);
    this.stepBossProjectiles(dt);

    this.resolveCollisions();
    this.checkBossTrigger();
    this.updateHud();
  }

  /** Arrow keys move the cube; WASD is accepted as an equivalent alias. */
  private readInput(engine: Engine): PlayerInput {
    const keyboard = engine.input.keyboard;
    return {
      left: keyboard.isHeld(Keys.ArrowLeft) || keyboard.isHeld(Keys.A),
      right: keyboard.isHeld(Keys.ArrowRight) || keyboard.isHeld(Keys.D),
      up: keyboard.isHeld(Keys.ArrowUp) || keyboard.isHeld(Keys.W),
      down: keyboard.isHeld(Keys.ArrowDown) || keyboard.isHeld(Keys.S),
    };
  }

  private tryFire(): void {
    if (!this.player.alive || this.player.fireCooldown > 0) return;

    const volley = fireVolley(this.player, {
      width: BULLET.width,
      height: BULLET.height,
      speed: this.player.bulletSpeed,
      life: BULLET.life,
      muzzleOffset: PLAYER.muzzleOffset,
      count: this.player.bulletCount,
      spreadRadians: BULLET.spreadRadians,
      damage: this.player.bulletDamage,
    });

    for (const state of volley) {
      const actor = new BulletActor();
      actor.sync(state);
      this.add(actor);
      this.bullets.push({ state, actor });
    }

    this.player.fireCooldown = this.player.fireInterval;
  }

  private stepBullets(dt: number): void {
    const survivors: Live<BulletState>[] = [];
    for (const bullet of this.bullets) {
      stepBullet(bullet.state, dt);
      if (isBulletSpent(bullet.state, FIELD.right)) {
        bullet.actor.kill();
        continue;
      }
      bullet.actor.sync(bullet.state);
      survivors.push(bullet);
    }
    this.bullets = survivors;
  }

  private spawnEnemies(dt: number): void {
    if (!this.spawner.update(dt, this.elapsed)) return;

    const kind = chooseEnemyKind(Math.random, ENEMY_KINDS);
    const state = spawnEnemy(Math.random, kind, ENEMY_KINDS[kind], FIELD);
    const actor = new EnemyActor(kind);
    actor.sync(state);
    this.add(actor);
    this.enemies.push({ state, actor });
  }

  private stepEnemies(dt: number): void {
    const survivors: Live<EnemyState>[] = [];
    const playerCenterY = this.player.y + this.player.h / 2;
    for (const enemy of this.enemies) {
      stepEnemy(enemy.state, dt, FIELD, playerCenterY);
      if (isEnemyGone(enemy.state, FIELD.left)) {
        enemy.actor.kill();
        continue;
      }
      enemy.actor.sync(enemy.state);
      survivors.push(enemy);
    }
    this.enemies = survivors;
  }

  private spawnAsteroids(dt: number): void {
    if (!this.asteroidSpawner.update(dt, this.elapsed)) return;

    const state = spawnAsteroid(Math.random, ASTEROID, FIELD);
    const actor = new AsteroidActor(state.r);
    actor.sync(state);
    this.add(actor);
    this.asteroids.push({ state, actor });
  }

  private stepAsteroids(dt: number): void {
    const survivors: Live<AsteroidState>[] = [];
    for (const asteroid of this.asteroids) {
      stepAsteroid(asteroid.state, dt, FIELD);
      if (isAsteroidGone(asteroid.state, FIELD.left)) {
        asteroid.actor.kill();
        continue;
      }
      asteroid.actor.sync(asteroid.state);
      survivors.push(asteroid);
    }
    this.asteroids = survivors;
  }

  private checkBossTrigger(): void {
    if (this.boss || this.score < this.nextBossAt) return;
    this.beginBossFight();
  }

  private beginBossFight(): void {
    const state = spawnBoss(Math.random, BOSS, FIELD, this.bossCount);
    const actor = new BossActor();
    actor.sync(state);
    this.add(actor);
    this.boss = { state, actor };
    this.bossCount += 1;
    // Schedule the next boss relative to the score at spawn time.
    this.nextBossAt = (Math.floor(this.score / BOSS_EVERY) + 1) * BOSS_EVERY;
  }

  private stepBossFight(dt: number): void {
    if (!this.boss) return;
    stepBoss(this.boss.state, dt, FIELD);
    this.boss.actor.sync(this.boss.state);

    if (tickBossAttack(this.boss.state, dt)) {
      this.fireBossBurst();
    }
  }

  /** Fire an aimed burst from the boss centre toward the player. */
  private fireBossBurst(): void {
    if (!this.boss) return;
    const boss = this.boss.state;
    const origin = { x: boss.x + boss.w / 2, y: boss.y + boss.h / 2 };
    const target = { x: this.player.x + this.player.w / 2, y: this.player.y + this.player.h / 2 };

    const volley = aimedVolley(origin, target, {
      size: BOSS.projectileSize,
      speed: boss.projectileSpeed,
      life: BOSS.projectileLife,
      count: boss.volley,
      spreadRadians: boss.spread,
    });

    for (const state of volley) {
      const actor = new ProjectileActor();
      actor.sync(state);
      this.add(actor);
      this.bossProjectiles.push({ state, actor });
    }
  }

  private stepBossProjectiles(dt: number): void {
    const survivors: Live<ProjectileState>[] = [];
    for (const projectile of this.bossProjectiles) {
      stepProjectile(projectile.state, dt);
      if (isProjectileSpent(projectile.state, FIELD)) {
        projectile.actor.kill();
        continue;
      }
      projectile.actor.sync(projectile.state);
      survivors.push(projectile);
    }
    this.bossProjectiles = survivors;
  }

  private resolveCollisions(): void {
    const spentBullets = new Set<Live<BulletState>>();
    const struckEnemies = new Set<Live<EnemyState>>();
    const struckAsteroids = new Set<Live<AsteroidState>>();
    const struckProjectiles = new Set<Live<ProjectileState>>();
    const playerBox = boxCorners(this.player);
    let bossDefeated = false;

    for (const enemy of this.enemies) {
      const hull = enemyVertices(enemy.state);

      for (const bullet of this.bullets) {
        if (spentBullets.has(bullet)) continue;
        if (polygonsOverlap(boxCorners(bullet.state), hull)) {
          spentBullets.add(bullet);
          struckEnemies.add(enemy);
          this.score += ENEMY_KINDS[enemy.state.kind].score;
          break;
        }
      }

      if (struckEnemies.has(enemy)) continue;

      if (polygonsOverlap(playerBox, hull)) {
        struckEnemies.add(enemy);
        if (damagePlayer(this.player, PLAYER.invulnSeconds) && !this.player.alive) {
          this.endRun();
        }
      }
    }

    // Boss: bullets chip away at its HP; contact hurts the player.
    if (this.boss) {
      const hull = enemyVertices(this.boss.state);
      for (const bullet of this.bullets) {
        if (spentBullets.has(bullet)) continue;
        if (polygonsOverlap(boxCorners(bullet.state), hull)) {
          spentBullets.add(bullet);
          damageBoss(this.boss.state, bullet.state.damage);
        }
      }

      if (isBossDead(this.boss.state)) {
        bossDefeated = true;
      } else if (polygonsOverlap(playerBox, hull)) {
        if (damagePlayer(this.player, PLAYER.invulnSeconds) && !this.player.alive) {
          this.endRun();
        }
      }
    }

    // Asteroids are indestructible: they soak bullets and hurt the player.
    for (const asteroid of this.asteroids) {
      for (const bullet of this.bullets) {
        if (spentBullets.has(bullet)) continue;
        if (circleBoxOverlap(asteroid.state, bullet.state)) {
          spentBullets.add(bullet);
          break;
        }
      }
    }

    for (const asteroid of this.asteroids) {
      if (circleBoxOverlap(asteroid.state, this.player)) {
        struckAsteroids.add(asteroid);
        if (damagePlayer(this.player, PLAYER.invulnSeconds) && !this.player.alive) {
          this.endRun();
        }
      }
    }

    // Boss projectiles hurt the player on contact.
    for (const projectile of this.bossProjectiles) {
      if (overlaps(projectile.state, this.player)) {
        struckProjectiles.add(projectile);
        if (damagePlayer(this.player, PLAYER.invulnSeconds) && !this.player.alive) {
          this.endRun();
        }
      }
    }

    if (spentBullets.size > 0) {
      for (const bullet of spentBullets) bullet.actor.kill();
      this.bullets = this.bullets.filter((bullet) => !spentBullets.has(bullet));
    }
    if (struckEnemies.size > 0) {
      for (const enemy of struckEnemies) enemy.actor.kill();
      this.enemies = this.enemies.filter((enemy) => !struckEnemies.has(enemy));
    }
    if (struckAsteroids.size > 0) {
      for (const asteroid of struckAsteroids) asteroid.actor.kill();
      this.asteroids = this.asteroids.filter((asteroid) => !struckAsteroids.has(asteroid));
    }
    if (struckProjectiles.size > 0) {
      for (const projectile of struckProjectiles) projectile.actor.kill();
      this.bossProjectiles = this.bossProjectiles.filter(
        (projectile) => !struckProjectiles.has(projectile),
      );
    }

    if (bossDefeated) {
      this.defeatBoss();
    }
  }

  private defeatBoss(): void {
    if (!this.boss) return;

    this.boss.actor.kill();
    this.boss = null;
    this.score += BOSS.score;
    this.nextBossAt = (Math.floor(this.score / BOSS_EVERY) + 1) * BOSS_EVERY;

    const upgrade = nextUpgrade(this.upgradesTaken, this.upgradeList);
    upgrade.apply(this.player);
    this.upgradesTaken += 1;

    // Debug: log boss count and lives at defeat time
    console.log(`[defeatBoss] bossCount=${this.bossCount}, lives before=${this.player.lives}, upgrade=${upgrade.name}`);

    // Always hide boss HUD
    this.hud.hideBoss();

    // Grant an extra life every other boss (2, 4, 6...), capped at 3.
    const grantExtraLife = this.bossCount % 2 === 0 && this.player.lives < 3;
    if (grantExtraLife) {
      this.player.lives += 1;
      this.hud.setLives(this.player.lives);
      console.log(`[defeatBoss] EXTRA LIFE GRANTED! lives now=${this.player.lives}`);
    }

    // Show toasts: extra life first (if granted), then upgrade
    if (grantExtraLife) {
      this.hud.showToast(`Extra Life! — +1 Life (${this.player.lives}/3)`);
      this.toastTimer = TOAST_SECONDS;
      // Chain the upgrade toast after the extra life toast
      setTimeout(() => {
        if (!this.gameOver) {
          this.hud.showToast(`${upgrade.name} — ${upgrade.describe}`);
          this.toastTimer = TOAST_SECONDS;
        }
      }, TOAST_SECONDS * 1000 + 200);
    } else {
      this.hud.showToast(`${upgrade.name} — ${upgrade.describe}`);
      this.toastTimer = TOAST_SECONDS;
    }
  }

  private updateHud(): void {
    this.hud.setScore(this.score);
    this.hud.setLives(this.player.lives);
    if (this.boss) {
      this.hud.setBossHp(this.boss.state.hp, this.boss.state.maxHp);
    } else {
      this.hud.hideBoss();
    }
  }

  private tickToast(dt: number): void {
    if (this.toastTimer <= 0) return;
    this.toastTimer -= dt;
    if (this.toastTimer <= 0) {
      this.hud.hideToast();
    }
  }

  private endRun(): void {
    this.gameOver = true;
    this.hud.hideBoss();
    this.hud.showMessage('GAME OVER', `Score ${this.score} — press Enter to play again`);
  }

  private restart(): void {
    for (const bullet of this.bullets) bullet.actor.kill();
    for (const enemy of this.enemies) enemy.actor.kill();
    for (const asteroid of this.asteroids) asteroid.actor.kill();
    for (const projectile of this.bossProjectiles) projectile.actor.kill();
    if (this.boss) this.boss.actor.kill();
    this.bullets = [];
    this.enemies = [];
    this.asteroids = [];
    this.bossProjectiles = [];
    this.boss = null;

    this.player = createPlayer(PLAYER.startX, PLAYER.size, PLAYER.lives, FIELD);
    this.playerActor.sync(this.player);
    this.spawner = new Spawner(Math.random, ENEMY_SPAWN);
    this.asteroidSpawner = new Spawner(Math.random, ASTEROID_SPAWN);
    this.score = 0;
    this.elapsed = 0;
    this.gameOver = false;
    this.nextBossAt = BOSS_EVERY;
    this.bossCount = 0;
    this.upgradesTaken = 0;
    this.toastTimer = 0;

    this.hud.setScore(this.score);
    this.hud.setLives(this.player.lives);
    this.hud.hideBoss();
    this.hud.hideToast();
    this.hud.hideMessage();
  }
}
